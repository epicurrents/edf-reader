/**
 * EpiCurrents EDF recording shared worker implementation.
 * Signal data is cached here, because cloning large amounts of data between the main thread
 * and this web worker can lead to serious memory leaks if the garbage collector cannot keep up.
 * Most compute-intensive tasks such as montage computation, signal interpolation and filtering
 * are also carried out here, outside the main thread.
 * @package    @epicurrents/edf-file-loader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import { BiosignalMutex } from '@epicurrents/core'
import {
    combineSignalParts,
    partsNotCached,
    isAnnotationSignal,
    NUMERIC_ERROR_VALUE,
    sleep
} from '@epicurrents/core/dist/util'
import {
    COMBINING_SIGNALS_FAILED,
    SIGNAL_CACHE_NOT_INITIALIZED,
    STUDY_PARAMETERS_NOT_SET,
    CACHE_ALREADY_INITIALIZED,
} from '@epicurrents/core/dist/errors/workers'
import {
    type AppSettings,
    type BiosignalAnnotation,
    type BiosignalChannel,
    type BiosignalHeaderRecord,
    type LoadDirection,
    type SignalCachePart,
    type SignalCacheProcess,
} from '@epicurrents/core/dist/types'
import EdfDecoder from './EdfDecoder'
import EdfFileReader from './EdfFileReader'
import { type EdfHeader, type EdfSignalPart } from '#types/edf'
import IOMutex from 'asymmetric-io-mutex'
import { log } from '@epicurrents/core/dist/util'

const SCOPE = "EdfWorker"

/** The cached signal data. */
const CACHE = {
    start: 0,
    end: 0,
    signals: []
} as SignalCachePart
/** The decoder used to load data from the EDF file. */
let DECODER = null as null | EdfDecoder
/** Metadata for the recording. */
const RECORDING = {
    annotations: new Map<number, BiosignalAnnotation[]>(),
    channels: [] as BiosignalChannel[],
    /** Recording data block structure. */
    dataBlocks: [] as {
        startRecord: number
        endRecord: number
        startTime: number
        endTime: number
    }[],
    dataGaps: new Map<number, number>(),
    /** Actual signal data length without gaps. */
    dataLength: 0,
    /** Parsed header of the EDF recording. */
    header: null as EdfHeader | null,
    maxDataBlocks: 0,
    dataRecordSize: 0,
    /** Total recording length including data gaps. */
    totalLength: 0,
}
/** Ongoing cache process. */
const cacheProcesses = [] as SignalCacheProcess[]
/** Promise awaiting data to update. */
let awaitData = null as null | {
    range: number[],
    resolve: () => void,
    timeout: any,
}
/** Has the cache been set up. */
let isCacheSetup = false

/** Maximum time to wait for missing signals to me loaded, in milliseconds. */
const AWAIT_SIGNALS_TIME = 5000

// Apply initial settings.
const SETTINGS = {} as AppSettings

onmessage = async (message: any) => {
    if (!message?.data?.action) {
        return
    }
    const action = message.data.action
    log(postMessage, 'DEBUG', `Received message with action ${action}.`, SCOPE)
    if (action === 'cache-signals-from-url') {
        try {
            cacheSignalsFromUrl()
        } catch (e) {
            log(postMessage, 'ERROR',
                `An error occurred while trying to cache signals, operation was aborted.`,
            SCOPE, e as Error)
        }
    } else if (action === 'get-signals') {
        // The direct get-signals should only be encountered when the requested signals have not been cached yet,
        // so whenever raw signals are requested and very rarely in other cases. Thus no need to use a lot of
        // time to optimize this method.
        if (!CACHE.signals.length) {
            log(postMessage, 'ERROR', `Cannot return signals if signal cache is not yet initialized.`, SCOPE)
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
            return
        }
        try {
            const sigs = await getSignals(message.data.range, message.data.config)
            const annos = getAnnotations(message.data.range)
            const gaps = getDataGaps(message.data.range)
            if (sigs) {
                postMessage({
                    action: action,
                    success: true,
                    signals: sigs,
                    annotations: annos,
                    dataGaps: gaps,
                    range: message.data.range,
                    rn: message.data.rn,
                })
            } else {
                postMessage({
                    action: action,
                    success: false,
                    rn: message.data.rn,
                })
            }
        } catch (e) {
        }
    } else if (action === 'setup-cache') {
        if (await setupCache()) {
            // Pass the generated shared buffers back to main thread.
            postMessage({
                action: action,
                success: true,
                rn: message.data.rn,
            })
        } else {
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
        }
    } else if (action === 'release-cache') {
        await releaseCache()
        postMessage({
            action: action,
            success: true,
            rn: message.data.rn,
        })
    } else if (action === 'setup-study') {
        // Check EDF header.
        if (!message.data.formatHeader?.reserved?.startsWith('EDF')) {
            log(postMessage, 'ERROR', `Format-specific header is not an EDF-compatible format.`, 'EdfWorker')
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
        }
        if (await setupStudy(
                message.data.header,
                message.data.formatHeader,
                message.data.url
            )
        ) {
            postMessage({
                action: action,
                dataLength: RECORDING.dataLength,
                recordingLength: RECORDING.totalLength,
                success: true,
                rn: message.data.rn,
            })
        } else {
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
        }
    } else if (action === 'shutdown') {
        await releaseCache()
    } else if (action === 'update-settings') {
        Object.assign(SETTINGS, message.data.settings)
    }
}
// This CANNOT be defined before onmessage.
const fileLoader = new EdfFileReader(onmessage, postMessage)

/**
 * Add new, unique annotations to the annotation cache.
 * @param annotations - New annotations to check and cache.
 */
const cacheNewAnnotations = (...annotations: BiosignalAnnotation[]) => {
    // Arrange the annotations by record.
    const recordAnnos = [] as BiosignalAnnotation[][]
    for (const anno of annotations) {
        if (!anno) {
            continue
        }
        const annoRec = Math.round(anno.start/RECORDING.dataRecordSize)
        if (!recordAnnos[annoRec]) {
            recordAnnos[annoRec] = []
        }
        recordAnnos[annoRec].push(anno)
    }
    new_loop:
    for (const newKey of recordAnnos.keys()) {
        for (const exsistingKey of Object.keys(RECORDING.annotations)) {
            if (newKey === parseFloat(exsistingKey)) {
                continue new_loop
            }
        }
        RECORDING.annotations.set(newKey, recordAnnos[newKey])
    }
}

/**
 * Add new, unique data gaps to the data gap cache.
 * @param newGaps - New data gaps to check and cache.
 */
const cacheNewDataGaps = (newGaps: Map<number, number>) => {
    new_loop:
    for (const newGap of newGaps) {
        if (!newGap[1] || newGap[1] < 0) {
            continue
        }
        for (const exsistingGap of RECORDING.dataGaps) {
            if (newGap[0] === exsistingGap[0]) {
                continue new_loop
            }
        }
        RECORDING.dataGaps.set(newGap[0], newGap[1])
    }
    // We need to sort the gaps to make sure keys appear in ascending order.
    RECORDING.dataGaps = new Map([...RECORDING.dataGaps.entries()].sort((a, b) => a[0] - b[0]))
}

/**
 * Cache raw signals from the file at the given URL.
 * @param url - Optional URL to the file.
 * @returns Success (true/false).
 */
const cacheSignalsFromUrl = async (startFrom: number = 0) => {
    if (!RECORDING.header) {
        log(postMessage, 'ERROR', [`Could not cache signals.`, STUDY_PARAMETERS_NOT_SET], SCOPE)
        postMessage({
            action: 'cache-signals-from-url',
            success: false,
            error: STUDY_PARAMETERS_NOT_SET
        })
        return false
    }
    if (!isCacheSetup) {
        log(postMessage, 'ERROR', [`Could not cache signals.`, SIGNAL_CACHE_NOT_INITIALIZED], SCOPE)
        postMessage({
            action: 'cache-signals-from-url',
            success: false,
            error: SIGNAL_CACHE_NOT_INITIALIZED
        })
        return false
    }
    // Must multiply size by two because of 16 bit int => 32 bit float conversion.
    const totalSignalDataSize = RECORDING.dataRecordSize*RECORDING.header.dataRecordCount*2
    // Get an array of parts that are in the process of being cached.
    const cacheTargets = cacheProcesses.map(proc => proc.target)
    // If we're at the start of the recording and can cache it entirely, just do that.
    if (SETTINGS.app.maxLoadCacheSize >= totalSignalDataSize) {
        log(postMessage, 'DEBUG', `Loading the whole recording to cache.`, SCOPE)
        const requestedPart = {
            start: 0,
            end: RECORDING.dataLength,
            signals: []
        } as SignalCachePart
        // Check what if any parts still need to be cached.
        const partsToCache = partsNotCached(requestedPart, ...cacheTargets)
        // No need to continue if there is nothing left to cache.
        if (!partsToCache.length) {
            return
        }
        // Othwewise, add the parts that still need caching into ongoing processes.
        const newCacheProcs = partsToCache.map(part => {
            return {
                continue: true,
                direction: 'forward', // The simple cache only loads signals in the forward direction.
                start: part.start,
                end: part.start,
                signals: [],
                target: part
            } as SignalCacheProcess
        })
        cacheProcesses.push(...newCacheProcs)
        // Start loading missing parts consecutively.
        for (const proc of newCacheProcs) {
            let nextPart = proc.start
            while (nextPart >= 0 && nextPart < proc.target.end) {
                // Continue loading records, but don't hog the entire thread.
                if (proc.continue) {
                    [nextPart] = await Promise.all([
                        loadAndCachePart(nextPart, proc),
                        sleep(10)
                    ])
                }
                proc.end = nextPart
            }
        }
    } else {
        log(postMessage, "ERROR",
            `Required amount of memory ${totalSignalDataSize} exceeds available memory ` +
            `${SETTINGS.app.maxLoadCacheSize}.`,
        SCOPE)
    }
    return true
}

/**
 * Convert cache time (i.e. time without data gaps) to recording time.
 * @param time - Cache time without gaps.
 * @returns Matching recording time (with gaps).
 */
const cacheTimeToRecordingTime = (time: number): number => {
    if (!RECORDING.header) {
        log(postMessage, 'ERROR',
            `Cannot convert cache time to recording time before study parameters have been set.`,
        SCOPE)
        return NUMERIC_ERROR_VALUE
    }
    if (time === NUMERIC_ERROR_VALUE) {
        return time
    }
    if (time < 0 || time > RECORDING.dataLength) {
        log(postMessage, 'ERROR',
            `Cannot convert cache time to recording time, given time ${time} is out of recording bounds ` +
            `(0 - ${RECORDING.dataLength}).`,
        SCOPE)
        return NUMERIC_ERROR_VALUE
    }
    if (!time || !RECORDING.header.discontinuous) {
        return time
    }
    return dataRecordIndexToTime(time/RECORDING.header.dataRecordDuration)
}

/**
 * Convert a data record index into timestamp.
 * @param index - Data record index to convert.
 * @returns Recording timestamp in seconds.
 */
const dataRecordIndexToTime = (index: number) => {
    if (!RECORDING.header) {
        log(postMessage, 'ERROR',
            `Cannot convert data record index to time before study parameters have been set.`,
        SCOPE)
        return NUMERIC_ERROR_VALUE
    }
    if (index < 0 || index > RECORDING.header.dataRecordCount) {
        log(postMessage, 'ERROR',
            `Cannot convert data record index to time, given index ${index} is out of recording bounds ` +
            `(0 - ${RECORDING.header.dataRecordCount}).`,
        SCOPE)
        return NUMERIC_ERROR_VALUE
    }
    let priorGapsTotal = 0
    for (const gap of RECORDING.dataGaps) {
        if (gap[0] < index*RECORDING.header.dataRecordDuration) {
            priorGapsTotal += gap[1]
        }
    }
    return index*RECORDING.header.dataRecordDuration + priorGapsTotal
}

/**
 * Get any cached annotations from data records in the provided `range`.
 * @param range - Recording range in seconds [inluded, excluded].
 * @returns List of annotations as BiosignalAnnotation[].
 */
const getAnnotations = (range?: number[]): BiosignalAnnotation[] =>{
    let [start, end] = range || [0, RECORDING.totalLength]
    if (!RECORDING.header) {
        log(postMessage, 'ERROR', "Cannot load annotations, recording header has not been loaded yet.", SCOPE)
        return []
    }
    if (!isCacheSetup) {
        log(postMessage, 'ERROR', `Cannot load annoations before signal cache has been initiated.`, SCOPE)
        return []
    }
    if (start < 0 || start >= RECORDING.totalLength) {
        log(postMessage, 'ERROR', `Requested annotation range ${start} - ${end} was out of recording bounds.`, SCOPE)
        return []
    }
    if (start >= end) {
        log(postMessage, 'ERROR', `Requested annotation range ${start} - ${end} was empty or invalid.`, SCOPE)
        return []
    }
    if (end > RECORDING.totalLength) {
        end = RECORDING.totalLength
    }
    const annotations = [] as BiosignalAnnotation[]
    for (const [rec, annos] of RECORDING.annotations.entries()) {
        for (const anno of annos) {
            if (anno.start >= start && anno.start < end) {
                annotations.push(anno)
            }
        }
    }
    return annotations
}

/**
 * Retrieve data gaps in the given `range`.
 * @param range - Time range to check in seconds (both exclusive).
 * @remarks
 * Both the starting and ending data records are excluded, because there cannot be a data gap inside just one record.
 */
const getDataGaps = (range?: number[]): { duration: number, start: number }[] => {
    let [start, end] = range || [0, RECORDING.totalLength]
    const dataGaps = [] as { duration: number, start: number }[]
    if (!RECORDING.header) {
        log(postMessage, 'ERROR', "Cannot load data gaps, recording header has not been loaded yet.", SCOPE)
        return dataGaps
    }
    if (!isCacheSetup) {
        log(postMessage, 'ERROR', `Cannot return data gaps before signal buffers have been initiated.`, SCOPE)
        return dataGaps
    }
    if (start < 0) {
        log(postMessage, 'ERROR', `Requested data gap range start ${start} was smaller than zero.`, SCOPE)
        return dataGaps
    }
    if (start >= end - RECORDING.header.dataRecordDuration) {
        return dataGaps
    }
    if (end > RECORDING.totalLength) {
        end = RECORDING.totalLength
    }
    let priorGapsTotal = 0
    for (const gap of RECORDING.dataGaps) {
        const gapTime = gap[0] + priorGapsTotal
        priorGapsTotal += gap[1]
        if (gapTime + gap[1] <= start) {
            continue
        } else if (gapTime < start && gapTime + gap[1] > start) {
            // Prior gap partially extends to the checked range.
            if (gapTime + gap[1] < end) {
                dataGaps.push({ start: start, duration: gapTime + gap[1] - start })
            } else {
                dataGaps.push({ start: start, duration: end - start })
                break
            }
        } else if (gapTime >= start && gapTime < end) {
            if (gapTime + gap[1] < end) {
                dataGaps.push({ start: gapTime, duration: gap[1] })
            } else {
                dataGaps.push({ start: gapTime, duration: end - gapTime })
                break
            }
        } else {
            break
        }
    }
    return dataGaps
}

const getGapTimeBetween = (start: number, end: number): number => {
    if (!RECORDING.header || !RECORDING.header.discontinuous) {
        return 0
    }
    let gapTotal = 0
    for (const gap of getDataGaps([start, end])) {
        gapTotal += gap.duration
    }
    return gapTotal
}

/**
 * Get current signal cache range.
 * @returns Range as { start: number, end: number } measured in seconds or NUMERIC_ERROR_VALUE if an error occurred.
 */
const getSignalCacheRange = () => {
    if (!CACHE) {
        return { start: NUMERIC_ERROR_VALUE, end: NUMERIC_ERROR_VALUE }
    }
    if (!CACHE.end || CACHE.start === CACHE.end) {
        log(postMessage, 'ERROR',
            `Signal cache does not have a valid range: ${CACHE.start} - ${CACHE.end}.`,
        SCOPE)
        return { start: NUMERIC_ERROR_VALUE, end: NUMERIC_ERROR_VALUE }
    }
    return { start: CACHE.start, end: CACHE.end }
}

/**
 * Load part of raw recording signals.
 * @param start - Start time as seconds.
 * @param end - End time as seconds.
 * @param unknown - Are the loaded signals unknown, or especially, can they contain unknown gaps. If true, final end time is corrected to contain new gaps.
 * @returns Promise with signals and corrected start and end times.
 */
const getSignalPart = async (start: number, end: number, unknown = true)
    : Promise<EdfSignalPart | null> =>
{
    if (!DECODER || !RECORDING.header || !RECORDING.dataRecordSize || !fileLoader.dataUnitSize) {
        log(postMessage, 'ERROR', "Cannot load file part, study has not been set up yet.", SCOPE)
        return null
    }
    if (!isCacheSetup) {
        log(postMessage, 'ERROR', `Cannot load file part before signal buffers have been initiated.`, SCOPE)
        return null
    }
    if (!RECORDING.header.dataRecordDuration) {
        log(postMessage, 'ERROR', "Cannot load file part, recording data record duration is zero.", SCOPE)
        return null
    }
    if (start < 0 || start >= RECORDING.totalLength) {
        log(postMessage, 'ERROR', `Requested signal range ${start} - ${end} was out of recording bounds.`, SCOPE)
        return null
    }
    if (start >= end) {
        log(postMessage, 'ERROR', `Requested signal range ${start} - ${end} was empty or invalid.`, SCOPE)
        return null
    }
    if (end > RECORDING.totalLength) {
        end = RECORDING.totalLength
    }
    const priorGaps = start > 0 ? getGapTimeBetween(0, start) : 0
    const innerGaps = getGapTimeBetween(start, end)
    const fileStart = start - priorGaps
    const fileEnd = end - priorGaps - innerGaps
    const filePart = await fileLoader.loadPartFromFile(fileStart, fileEnd - fileStart)
    if (!filePart) {
        log(postMessage, 'ERROR', `File loader couldn't load EDF part between ${fileStart}-${fileEnd}.`, SCOPE)
        return { signals: [], start: start, end: end }
    }
    const recordsPerSecond = 1/RECORDING.header.dataRecordDuration
    // This block is meant to catch possible errors in EdfDecoder and signal interpolation.
    try {
        // Slice a part of the file to process.
        const startPos = Math.round((fileStart - filePart.start)*RECORDING.dataRecordSize*recordsPerSecond)
        const endPos = startPos + Math.round((filePart.length)*RECORDING.dataRecordSize*recordsPerSecond)
        if (startPos < 0) {
            log(postMessage, 'ERROR', `File starting position is smaller than zero (${startPos})!`, SCOPE)
            throw new Error()
        }
        if (startPos >= endPos) {
            log(postMessage, 'ERROR', `File starting position is greater than ending position (${startPos} > ${endPos})!`, SCOPE)
            throw new Error()
        }
        if (endPos > filePart.data.size) {
            log(postMessage, 'WARN', `File ending position is greater than the file size (${endPos} > ${filePart.data.size})!`, SCOPE)
            filePart.length = (filePart.data.size - startPos)/(RECORDING.dataRecordSize*recordsPerSecond)
        }
        const chunk = filePart.data.slice(startPos, Math.min(endPos, filePart.data.size))
        const chunkBuffer = await chunk.arrayBuffer()
        // Byte offset is always 0, as we slice the data to start from the correct position.
        // Add up all data gaps until this point.
        const edfData = DECODER.decodeData(
                                RECORDING.header,
                                chunkBuffer,
                                0,
                                (start - priorGaps)*recordsPerSecond,
                                filePart.length/RECORDING.header.dataRecordDuration,
                                priorGaps
                            )
        if (!edfData?.signals) {
            return {
                signals: [],
                start: start,
                end: end,
            }
        }
        if (edfData.annotations.length) {
            cacheNewAnnotations(...edfData.annotations)
        }
        if (edfData.dataGaps.size) {
            cacheNewDataGaps(edfData.dataGaps)
            if (unknown) {
                // Include new gaps to end time.
                let total = 0
                for (const gap of edfData.dataGaps.values()) {
                    total += gap
                }
                end += total - innerGaps // Total minus already known gaps.
            }
        }
        const cacheSignals = [] as SignalCachePart["signals"]
        // Interpolate physical signals if needed (raw signals are kept as they are).
        for (let i=0; i<edfData.signals.length; i++) {
            const sigSr = RECORDING.header.signalInfo[i].sampleCount*recordsPerSecond
            const isAnnotation = isAnnotationSignal(RECORDING.header.reserved, RECORDING.header.signalInfo[i])
                                 ? true : false
            cacheSignals.push({
                data: isAnnotation ? new Float32Array() : edfData.signals[i],
                samplingRate: isAnnotation ? 0 : sigSr,
            })
        }
        return {
            signals: cacheSignals,
            start: start,
            end: end,
            annotations: edfData.annotations,
            dataGaps: edfData.dataGaps,
        }
    } catch (e) {
        log(postMessage, 'ERROR', `Failed to load signal part between ${start} and ${end}!`, SCOPE, e as Error)
        return null
    }
}

/**
 * Get signals for the given part.
 * @param range - Range in seconds as [start, end].
 * @param config - Optional configuration.
 */
const getSignals = async (range: number[], config?: any) => {
    if (!RECORDING.header || !CACHE) {
        log(postMessage, 'ERROR', "Cannot load signals, signal buffers have not been set up yet.", SCOPE)
        return null
    }
    if (!isCacheSetup) {
        log(postMessage, 'ERROR', `Cannot load signals before signal buffers have been initiated.`, SCOPE)
        return null
    }
    if (range[0] === range[1]) {
        log(postMessage, 'ERROR', `Cannot load signals from an empty range ${range[0]} - ${range[1]}.`, SCOPE)
        return null
    }
    // Get current signal cache range.
    const bufferRange = await getSignalCacheRange()
    if (bufferRange.start >= bufferRange.end) {
        log(postMessage, 'ERROR', `The signal cache mutex did not return a valid signal range.`, SCOPE)
        return null
    }
    let requestedSigs: SignalCachePart | null = null
    if (bufferRange.start > range[0] || bufferRange.end < Math.min(range[1], RECORDING.dataLength)) {
        // Fetch the requested part from signal file.
        try {
            requestedSigs = await getSignalPart(range[0], range[1])
            if (!requestedSigs) {
                return null
            }
        } catch (e) {
            log(postMessage, 'ERROR', `Loading signals for range [${range[0]}, ${range[1]}] failed.`, SCOPE, e as Error)
            return null
        }
    }
    // Make sure we have the requested range of signals.
    const loadedSignals = getSignalUpdatedRange()
    if (loadedSignals.start === NUMERIC_ERROR_VALUE || loadedSignals.end === NUMERIC_ERROR_VALUE) {
        if (!cacheProcesses.length) {
            log(postMessage, 'ERROR', `Loading signals for range [${range[0]}, ${range[1]}] failed, cannot read updated signal ranges.`, SCOPE)
            return null
        }
    }
    if (
        (
            (loadedSignals.start > range[0] && loadedSignals.start > 0) ||
            (loadedSignals.end < range[1] && loadedSignals.end < RECORDING.totalLength)
        ) &&
        cacheProcesses.length
    ) {
        log(postMessage, 'DEBUG', `Requested signals have not been loaded yet, waiting for ${(AWAIT_SIGNALS_TIME/1000)} seconds.`, SCOPE)
        // Set up a promise to wait for an active data loading process to load the missing data.
        const dataUpdatePromise = new Promise<void>((resolve) => {
            awaitData = {
                range: range,
                resolve: resolve,
                timeout: setTimeout(resolve, AWAIT_SIGNALS_TIME),
            }
        })
        await dataUpdatePromise
        if (awaitData?.timeout) {
            clearTimeout(awaitData.timeout)
        } else {
            log(postMessage, 'DEBUG', `Timeout reached when waiting for missing signals.`, SCOPE)
        }
        awaitData = null
    }
    // Filter channels, if needed.
    const included = [] as number[]
    // Prioritize include -> only process those channels.
    if (config?.include?.length) {
        for (let i=0; i<CACHE.signals.length; i++) {
            if (config.include.indexOf(i) !== -1) {
                included.push(i)
            } else {
                log(postMessage, 'DEBUG', `Not including channel #${i} in requested signals.`, SCOPE)
            }
        }
    } else if (config?.exclude?.length) {
        for (let i=0; i<CACHE.signals.length; i++) {
            if (config.exclude.indexOf(i) === -1) {
                included.push(i)
            } else {
                log(postMessage, 'DEBUG', `Excuding channel #${i} from requested signals.`, SCOPE)
            }
        }
    }
    const responseSigs = []
    // Find amount of gap time before and within the range.
    const dataGaps = getDataGaps(range)
    const priorGapsTotal = range[0] > 0 ? getGapTimeBetween(0, range[0]) : 0
    const innerGapsTotal = getGapTimeBetween(range[0], range[1])
    const rangeStart = range[0] - priorGapsTotal
    const rangeEnd = range[1] - priorGapsTotal - innerGapsTotal
    for (let i=0; i<CACHE.signals.length; i++) {
        if (included.length && included.indexOf(i) === -1) {
            continue
        }
        const signalForRange = new Float32Array(
            Math.round((range[1] - range[0])*CACHE.signals[i].samplingRate)
        ).fill(0.0)
        if (rangeStart === rangeEnd) {
            // The whole range is just gap space.
            responseSigs.push(signalForRange)
            continue
        }
        const startSignalIndex = Math.round((rangeStart - CACHE.start)*CACHE.signals[i].samplingRate)
        const endSignalIndex = Math.round((rangeEnd - CACHE.start)*CACHE.signals[i].samplingRate)
        signalForRange.set(CACHE.signals[i].data.slice(startSignalIndex, endSignalIndex))
        for (const gap of dataGaps) {
            const startPos = Math.round((gap.start - range[0])*CACHE.signals[i].samplingRate)
            const endPos = Math.min(
                startPos + Math.round(gap.duration*CACHE.signals[i].samplingRate),
                startPos + signalForRange.length
            )
            // Move the existing array members upward.
            const remainder = signalForRange.slice(
                startPos,
                startPos + signalForRange.length - endPos
            )
            if (endPos < signalForRange.length) {
                signalForRange.set(remainder, endPos)
            }
            // Replace with zeroes.
            signalForRange.set(
                new Float32Array(endPos - startPos).fill(0.0),
                startPos
            )
        }
        responseSigs.push(signalForRange)
    }
    return responseSigs
}

/**
 * Get the largest start and lowest end updated data range (in seconds) for the signals.
 * @returns Range as { start: number, end: number } measured in seconds or NUMERIC_ERROR_VALUE if an error occurred.
 */
const getSignalUpdatedRange = () => {
    if (!RECORDING.header || !CACHE) {
        return { start: NUMERIC_ERROR_VALUE, end: NUMERIC_ERROR_VALUE }
    }
    const ranges = CACHE.signals.map(s => {
        return {
            start: s.start !== undefined ? s.start : CACHE.start,
            end: s.end !== undefined ? s.end : CACHE.end
        }
    })
    const srs = CACHE.signals.map(s => s.samplingRate)
    if (!ranges || !srs) {
        log(postMessage, 'ERROR',
            `Signal updated ranges or sampling rates are not valid.`,
        SCOPE)
        return { start: NUMERIC_ERROR_VALUE, end: NUMERIC_ERROR_VALUE }
    }
    let highestStart = NUMERIC_ERROR_VALUE
    let lowestEnd = NUMERIC_ERROR_VALUE
    for (let i=0; i<ranges.length; i++) {
        const sr = srs[i]
        if (!sr) {
            // Empty or missing channel, skip.
            continue
        }
        const range = ranges[i]
        if (!range) {
            log(postMessage, 'ERROR',
                `Updated range for signal at index ${i} is nto valid.`,
            SCOPE)
            return { start: NUMERIC_ERROR_VALUE, end: NUMERIC_ERROR_VALUE }
        }
        const tStart = range.start/sr
        const tEnd = range.end/sr
        if (range.start !== IOMutex.EMPTY_FIELD) {
            highestStart = (highestStart === NUMERIC_ERROR_VALUE || tStart > highestStart) ? tStart : highestStart
        } else {
            log(postMessage, 'WARN', `Signal #${i} has not updated start position set.`, SCOPE)
        }
        if (range.end !== IOMutex.EMPTY_FIELD) {
            lowestEnd = (lowestEnd === NUMERIC_ERROR_VALUE || tEnd < lowestEnd) ? tEnd : lowestEnd
        } else {
            log(postMessage, 'WARN', `Signal #${i} has not updated end position set.`, SCOPE)
        }
    }
    if (highestStart === NUMERIC_ERROR_VALUE && lowestEnd === NUMERIC_ERROR_VALUE) {
        log(postMessage, 'ERROR', `Cannot get ranges of updated signals, cache has no initialized signals.`, SCOPE)
        return { start: NUMERIC_ERROR_VALUE, end: NUMERIC_ERROR_VALUE }
    }
    return { start: cacheTimeToRecordingTime(highestStart), end: cacheTimeToRecordingTime(lowestEnd) }
}

/**
 * Load the next signal part starting from the given record index and cache it.
 * @param start - Data record to start from (inclusive).
 * @param process - Optional cache process to use for information.
 * @returns Timestamp of next record to load (in seconds) or NUMERIC_ERROR_VALUE if an error occurred.
 */
const loadAndCachePart = async (start: number, process?: SignalCacheProcess) => {
    if (!RECORDING.header || !CACHE) {
        log(postMessage, 'DEBUG', `Could not load and cache part, recording or cache was not set up.`, SCOPE)
        return NUMERIC_ERROR_VALUE
    }
    if (start < 0 || start >= RECORDING.totalLength) {
        log(postMessage, 'DEBUG', `Could not load and cache part, start position was out of range.`, SCOPE)
        return NUMERIC_ERROR_VALUE
    }
    const dataChunkRecords = Math.max(
        Math.floor(SETTINGS.app.dataChunkSize/RECORDING.dataRecordSize),
        1 // Always load at least one record at a time.
    )
    let startRecord = start // timeToDataRecordIndex(start)
    let finalRecord = process ? process.target.end
                              : RECORDING.header.dataRecordCount
    let nextRecord = Math.min(
        startRecord + dataChunkRecords,
        finalRecord
    )
    if (nextRecord === startRecord + 1) {
        log(postMessage, 'DEBUG', `Loading complete at record index ${nextRecord}.`, SCOPE)
        // End of the line
        return nextRecord
    }
    try {
        const startTime = dataRecordIndexToTime(startRecord)
        const endTime = dataRecordIndexToTime(nextRecord)
        const newSignals = await getSignalPart(startTime, endTime)
        if (newSignals?.signals.length && (!process || process.continue)) {
            if (RECORDING.header.discontinuous) {
                // Convert start and end time to exclude gaps
                newSignals.start = recordingTimeToCacheTime(newSignals.start)
                newSignals.end = recordingTimeToCacheTime(newSignals.end)
            }
            combineSignalParts(CACHE, newSignals)
            const updated = getSignalUpdatedRange()
            if (
                updated.start === updated.end ||
                updated.start === NUMERIC_ERROR_VALUE ||
                updated.end === NUMERIC_ERROR_VALUE
            ) {
                log(postMessage, 'ERROR', `Inserting new signals to cache failed.`, SCOPE)
                return NUMERIC_ERROR_VALUE
            }
            // Report signal cache progress and send new annotation and data gap information.
            postMessage({
                action: 'cache-signals',
                annotations: getAnnotations([startTime, endTime]),
                // Data gap information can change as the file is loaded, they must always be reset.
                dataGaps: getDataGaps(),
                range: [updated.start, updated.end],
                success: true,
            })
            if (awaitData) {
                if (awaitData.range[0] >= updated.start && awaitData.range[1] <= updated.end) {
                    log(postMessage, 'DEBUG', `Awaited data loaded, resolving.`, SCOPE)
                    awaitData.resolve()
                }
            }
            nextRecord = timeToDataRecordIndex(updated.end)
            if (process) {
                // Update process.
                if (!combineSignalParts(process, newSignals)) {
                    log(postMessage, 'ERROR',
                        `Failed to combine signal parts ${process.start} - ${process.end} and ` +
                        `${newSignals.start} - ${newSignals.end}.`,
                    SCOPE)
                    postMessage({
                        action: 'get-signals',
                        success: false,
                        error: COMBINING_SIGNALS_FAILED
                    })
                    return NUMERIC_ERROR_VALUE
                }
            }
        }
        // Remove possible process as completed.
        if (process) {
            for (let i=0; i<cacheProcesses.length; i++) {
                if (cacheProcesses[i] === process) {
                    cacheProcesses.splice(i, 1)
                    break
                }
            }
        }
        return nextRecord
    } catch (e) {
        postMessage({
            action: 'get-signals',
            success: false,
            error: e
        })
        return NUMERIC_ERROR_VALUE
    }
}

/**
 * Convert recording time to cache time (i.e. time without data gaps).
 * @param time - Recording time.
 * @returns Matching cache time (without gaps).
 */
const recordingTimeToCacheTime = (time: number): number => {
    if (!RECORDING.header) {
        log(postMessage, 'ERROR',
            `Cannot convert recording time to cache time before study parameters have been set.`,
        SCOPE)
        return NUMERIC_ERROR_VALUE
    }
    if (time === NUMERIC_ERROR_VALUE) {
        return time
    }
    if (time < 0 || time > RECORDING.totalLength) {
        log(postMessage, 'ERROR',
            `Cannot convert recording time to cache time, given time ${time} is out of recording bounds ` +
            `(0 - ${RECORDING.totalLength}).`,
        SCOPE)
        return NUMERIC_ERROR_VALUE
    }
    if (!time || !RECORDING.header.discontinuous) {
        // Zero is always zero, continuous recording has the same cache and recording time.
        return time
    }
    return time - getGapTimeBetween(0, time)
}

/**
 * Release buffers removing all references to them and returning to initial state.
 */
const releaseCache = () => {
    for (const proc of cacheProcesses) {
        proc.continue = false
    }
    cacheProcesses.splice(0)
    CACHE?.signals.slice(0)
    CACHE.start = 0
    CACHE.end = 0
    isCacheSetup = false
}

/**
 * Initialize signal cache.
 * @returns True on success, false on failure.
 */
const setupCache = () => {
    if (isCacheSetup) {
        log(postMessage, 'WARN', `Tried to re-initialize already initialized cache.`, SCOPE)
        return true
    }
    if (!RECORDING.header) {
        log(postMessage, 'ERROR', [`Cannot initialize worker cache.`, STUDY_PARAMETERS_NOT_SET], SCOPE)
        return false
    }
    log(postMessage, 'DEBUG', `Initiating EDF worker cache.`, SCOPE)
    for (const sig of RECORDING.header.signalInfo) {
        CACHE.signals.push({
            data: new Float32Array(),
            samplingRate: isAnnotationSignal(RECORDING.header.dataFormat, sig) ? 0 // Don't cache annotation data.
                          : Math.round(sig.sampleCount/RECORDING.header.dataRecordDuration)
        })
    }
    log(postMessage, 'DEBUG', `EDF loader cache initiation complete.`, SCOPE)
    isCacheSetup = true
    return true
}

/**
 * Set up study params for file loading. This will initializes the shared array buffer for storing
 * the signal data and can only be done once. This method will send the true recording duration
 * to the main thread as part of the worker response object (response.recordingLength).
 * @param header - General biosignal header.
 * @param edfHeader - EDF format-specific header.
 * @param url - Source URL of the EDF data file.
 */
const setupStudy = async (header: BiosignalHeaderRecord, edfHeader: EdfHeader, url: string) => {
    // Make sure there aren't any cached signals yet.
    if (CACHE.signals.length) {
        log(postMessage, 'ERROR', [`Could not set study parameters.`, CACHE_ALREADY_INITIALIZED], SCOPE)
        return false
    }
    DECODER = new EdfDecoder(undefined, undefined, edfHeader)
    // Store the header for later use.
    RECORDING.header = edfHeader
    // Initialize file loader.
    fileLoader.cacheEdfInfo(edfHeader, header.dataRecordSize)
    fileLoader.url = url
    // Reset possible running cache processes.
    for (let i=0; i<cacheProcesses.length; i++) {
        cacheProcesses[i].continue = false
        cacheProcesses.splice(i, 1)
    }
    if (RECORDING.header.discontinuous) {
        // We need to fetch the true file duration from the last data record.
        const filePart = await fileLoader.loadPartFromFile((header.dataRecordCount - 1)*header.dataRecordDuration, 1)
        if (filePart) {
            const chunkBuffer = await filePart.data.arrayBuffer()
            // Byte offset is always 0, as we slice the data to start from the correct position.
            // Add up all data gaps until this point.
            const edfData = DECODER.decodeData(
                                        edfHeader,
                                        chunkBuffer,
                                        0,
                                        0,
                                        filePart.length/RECORDING.header.dataRecordDuration,
                                        0
                                    )
            // Remove possible added annotations and data gaps.
            RECORDING.annotations.clear()
            RECORDING.dataGaps.clear()
            RECORDING.totalLength = (edfData?.dataGaps.get(0) || 0) + RECORDING.header.dataRecordDuration
        }
    }
    RECORDING.totalLength = Math.max(RECORDING.totalLength, header.dataRecordCount*header.dataRecordDuration)
    RECORDING.dataLength = RECORDING.header.dataRecordCount*RECORDING.header.dataRecordDuration
    RECORDING.dataRecordSize = header.dataRecordSize
    // Construct SharedArrayBuffers and rebuild recording data block structure.
    RECORDING.dataBlocks = []
    const dataBlockLen = Math.max(Math.floor(SETTINGS.app.dataChunkSize/header.dataRecordSize), 1)
    RECORDING.maxDataBlocks = Math.floor(SETTINGS.app.maxLoadCacheSize/(dataBlockLen*header.dataRecordSize))
    for (let i=0; i<header.dataRecordCount; i+=dataBlockLen) {
        const endRecord = Math.min(i + dataBlockLen, header.dataRecordCount)
        RECORDING.dataBlocks.push({
            startRecord: i,
            startTime: i*RECORDING.header.dataRecordDuration,
            endRecord: endRecord,
            endTime: endRecord*RECORDING.header.dataRecordDuration
        })
    }
    return true
}

/**
 * Convert a recording timestamp to EDF data record index.
 * @param time - Timestamp in seconds to convert.
 * @returns Data record index.
 */
const timeToDataRecordIndex = (time: number): number => {
    if (!RECORDING.header) {
        log(postMessage, 'ERROR',
            `Cannot convert time to data record index before study parameters have been set.`,
        SCOPE)
        return NUMERIC_ERROR_VALUE
    }
    if (time > RECORDING.totalLength) {
        log(postMessage, 'ERROR',
            `Cannot convert time to data record index, given itime ${time} is out of recording bounds ` +
            `(0 - ${RECORDING.totalLength}).`,
        SCOPE)
        return NUMERIC_ERROR_VALUE
    }
    const priorGapsTotal = time > 0 ? getGapTimeBetween(0, time) : 0
    return Math.floor((time - priorGapsTotal)/RECORDING.header.dataRecordDuration)
}
