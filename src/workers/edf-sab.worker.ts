/**
 * EpiCurrents EDF recording worker; unloading that work from the main thread since 2021!
 * Seriously though, loading and parsing an EDF file is quite slow and can block the main thread for several seconds,
 * even on more powerful desktops.
 * Signal data is cached in a shared array buffer, because cloning large amounts of data between the main thread and
 * this web worker can lead to serious memory leaks if the garbage collector cannot keep up.
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
    sleep,
} from '@epicurrents/core/dist/util'
import {
    type AppSettings,
    type BiosignalAnnotation,
    type BiosignalChannel,
    type BiosignalHeaderRecord,
    type ConfigChannelFilter,
    type LoadDirection,
    type SignalCachePart,
    type SignalCacheProcess,
    type WorkerMessage,
} from '@epicurrents/core/dist/types'
import EdfDecoder from '../edf/EdfDecoder'
import EdfFileReader from '../edf/EdfFileReader'
import { type EdfHeader, type EdfSignalPart } from '#types/edf'
import IOMutex from 'asymmetric-io-mutex'
import { log } from '@epicurrents/core/dist/util'

const SCOPE = "EdfWorkerSAB"

const LOAD_DIRECTION_ALTERNATING: LoadDirection = 'alternate'
const LOAD_DIRECTION_BACKWARD: LoadDirection = 'backward'
const LOAD_DIRECTION_FORWARD: LoadDirection = 'forward'

/** Maximum time to wait for missing signals to me loaded, in milliseconds. */
const AWAIT_SIGNALS_TIME = 5000
/** The cached signal data. */
let CACHE: BiosignalMutex | null = null
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
    timeout: unknown,
}
/** Has the mutex been set up. */
let isMutexSetup = false

// Apply initial settings.
const SETTINGS = {} as AppSettings

onmessage = async (message: WorkerMessage) => {
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
        if (!CACHE?.outputSignalArrays.length) {
            log(postMessage, 'ERROR', `Cannot return signals if signal cache is not yet initialized.`, SCOPE)
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
            return
        }
        // Extract job parameters.
        const range = message.data.range as number[]
        const config = message.data.config as ConfigChannelFilter
        try {
            const sigs = await getSignals(range, config)
            const annos = getAnnotations(range)
            const gaps = getDataGaps(range)
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
            log(postMessage, 'ERROR', `Getting signals failed.`, SCOPE, e)
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
        }
    } else if (action === 'setup-cache') {
        const buffer = message.data.buffer as SharedArrayBuffer
        if (!buffer) {
            log(postMessage, 'ERROR', `Commission is missing a shared array buffer.`, SCOPE)
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
            return
        }
        const range = message.data.range as { start: number, end: number }
        if (!range) {
            log(postMessage, 'ERROR', `Commission is missing a buffer range.`, SCOPE)
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
            return
        }
        if (await setupCache(buffer, range.start)) {
            // Pass the generated shared buffers back to main thread.
            postMessage({
                action: action,
                cacheProperties: CACHE?.propertiesForCoupling,
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
        const formatHeader = message.data.formatHeader as EdfHeader | undefined
        if (!formatHeader) {
            log(postMessage, 'ERROR', `Commission is missing a format-specific header.`, SCOPE)
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
            return
        }
        const reserved = formatHeader.reserved as string | undefined
        if (!reserved?.startsWith('EDF')) {
            log(postMessage, 'ERROR', `Format-specific header is not an EDF-compatible format.`, SCOPE)
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
            return
        }
        const header = message.data.header as BiosignalHeaderRecord | undefined
        if (!header) {
            log(postMessage, 'ERROR', `Commission is missing a generic biosignal header.`, SCOPE)
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
            return
        }
        const url = message.data.url as string | undefined
        if (!url) {
            log(postMessage, 'ERROR', `Commission is missing a source URL.`, SCOPE)
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
            return
        }
        if (await setupStudy(header, formatHeader, url)) {
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
        log(postMessage, 'ERROR', [`Could not cache signals.`, `Study parameters have not been set.`], SCOPE)
        postMessage({
            action: 'cache-signals-from-url',
            success: false,
            error: `Study parameters have not been set.`
        })
        return false
    }
    if (!isMutexSetup) {
        log(postMessage, 'ERROR', [`Could not cache signals.`, `Signal cache has not been initialized.`], SCOPE)
        postMessage({
            action: 'cache-signals-from-url',
            success: false,
            error: `Signal cache has not been initialized.`
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
        if (startFrom) {
            // Not starting from the beginning, load initial part at location.
            await loadAndCachePart(startFrom)
        }
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
                direction: LOAD_DIRECTION_FORWARD,
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
        // Cannot load entire file.
        // The idea is to consider the cached signal data in three parts.
        // - Middle part is where the active view is (or should be).
        // - In addition, one third of cached data precedes it and one third follows it.
        // Whenever the active view enters the preceding or following third, a new "third" is loaded
        // to that end and the third at the far end is scrapped.
        // Get current signal cache range
        const range = await getSignalCacheRange()
        if (range.start === NUMERIC_ERROR_VALUE) {
            log(postMessage, 'ERROR', `The signal cache mutex did not return a valid signal range.`, SCOPE)
            return false
        }
        // First, check if current cache already has this part as one of the "thirds".
        const cacheThird = RECORDING.maxDataBlocks/3
        const firstThird = range.start + Math.round(cacheThird)
        const secondThird = range.start + Math.round(cacheThird*2)
        const lastThird = range.start + RECORDING.maxDataBlocks
        // Seek the data block the starting point is in.
        let nowInPart = 0
        if (startFrom) {
            for (let i=0; i<RECORDING.dataBlocks.length; i++) {
                if (RECORDING.dataBlocks[i].startTime <= startFrom && RECORDING.dataBlocks[i].endTime > startFrom) {
                    nowInPart = i
                }
            }
        }
        if (
            // Case when the cache does not start from the beginning of the recording, but view is in the middle third.
            startFrom >= firstThird && startFrom < secondThird ||
            // Case when it does (and view is in the first or middle third, this check must be in the first clause!).
            range.start === 0 && startFrom < secondThird
        ) {
            // We don't have to do any changes.
            return true
        } else if (startFrom < firstThird) {
            // Cache does not start from the beginning and the view is in the first third
            // -> ditch last block and load a preceding one.
            null
        } else if (
            startFrom >= secondThird && startFrom < lastThird ||
            range.start === 0 && startFrom < lastThird
        ) {
            // View in the last third -> ditch first block and load following data.

        } else {
            // Check if we are already in the process of loading this part.
            for (const proc of cacheProcesses) {
                // Same checks basically.
                const procFirstThird = proc.target.start + Math.round(cacheThird)
                const procSecondThird = proc.target.start + Math.round(cacheThird*2)
                const procLastThird = proc.target.start + RECORDING.maxDataBlocks
                if (
                    startFrom >= procFirstThird && startFrom < procSecondThird ||
                    proc.target.start === 0 && startFrom < procSecondThird
                ) {
                    return true
                } else if (startFrom < procFirstThird) {
                    null
                } else if (
                    startFrom >= procSecondThird && startFrom < procLastThird ||
                    proc.target.start === 0 && startFrom < procLastThird
                ) {
                    null
                }
            }
        }
        // First, load the next part (where the user will most likely browse).
        // TODO: Finish this method.
        nowInPart // Used here to determine the next part, suppress linting error.
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
    const [start, end] = range && range.length === 2
                         ? [range[0], Math.min(range[1], RECORDING.totalLength)]
                         : [0, RECORDING.totalLength]
    if (!RECORDING.header) {
        log(postMessage, 'ERROR', "Cannot load annotations, recording header has not been loaded yet.", SCOPE)
        return []
    }
    if (!isMutexSetup) {
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
    const annotations = [] as BiosignalAnnotation[]
    for (const annos of RECORDING.annotations.entries()) {
        for (const anno of annos[1]) {
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
    const [start, end] = range && range.length === 2
                         ? [range[0], Math.min(range[1], RECORDING.totalLength)]
                         : [0, RECORDING.totalLength]
    const dataGaps = [] as { duration: number, start: number }[]
    if (!RECORDING.header) {
        log(postMessage, 'ERROR', "Cannot load data gaps, recording header has not been loaded yet.", SCOPE)
        return dataGaps
    }
    if (!isMutexSetup) {
        log(postMessage, 'ERROR', `Cannot return data gaps before signal cache has been initiated.`, SCOPE)
        return dataGaps
    }
    if (start < 0) {
        log(postMessage, 'ERROR', `Requested data gap range start ${start} was smaller than zero.`, SCOPE)
        return dataGaps
    }
    if (start >= end - RECORDING.header.dataRecordDuration) {
        return dataGaps
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
const getSignalCacheRange = async () => {
    if (!CACHE) {
        return { start: NUMERIC_ERROR_VALUE, end: NUMERIC_ERROR_VALUE }
    }
    const rangeStart = await CACHE.outputRangeStart
    const rangeEnd = await CACHE.outputRangeEnd
    if (rangeStart === null || rangeEnd === null) {
        log(postMessage, 'ERROR',
            `Raw signal mutex did not report a valid range: start (${rangeStart}) or end (${rangeEnd}).`,
        SCOPE)
        return { start: NUMERIC_ERROR_VALUE, end: NUMERIC_ERROR_VALUE }
    }
    return { start: rangeStart, end: rangeEnd }
}

/**
 * Load part of raw recording signals.
 * @param start - Start time as seconds.
 * @param end - End time as seconds.
 * @param unknown - Are the loaded signals unknown, or especially, can they contain uknown gaps. If true, final end time is corrected to contain new gaps.
 * @returns Promise with signals and corrected start and end times.
 */
const getSignalPart = async (start: number, end: number, unknown = true)
    : Promise<EdfSignalPart | null> =>
{
    if (!DECODER || !RECORDING.header || !RECORDING.dataRecordSize || !fileLoader.dataUnitSize) {
        log(postMessage, 'ERROR', "Cannot load file part, study has not been set up yet.", SCOPE)
        return null
    }
    if (!isMutexSetup) {
        log(postMessage, 'ERROR', `Cannot load file part before signal cache has been initiated.`, SCOPE)
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
const getSignals = async (range: number[], config?: ConfigChannelFilter) => {
    if (!RECORDING.header || !CACHE) {
        log(postMessage, 'ERROR', "Cannot load signals, signal cache has not been set up yet.", SCOPE)
        return null
    }
    if (!isMutexSetup) {
        log(postMessage, 'ERROR', `Cannot load signals before signal cache has been initiated.`, SCOPE)
        return null
    }
    if (range[0] === range[1]) {
        log(postMessage, 'ERROR', `Cannot load signals from an empty range ${range[0]} - ${range[1]}.`, SCOPE)
        return null
    }
    // Get current signal cache range.
    const cacheRange = await getSignalCacheRange()
    if (cacheRange.start >= cacheRange.end) {
        log(postMessage, 'ERROR', `The signal cache mutex did not return a valid signal range.`, SCOPE)
        return null
    }
    let requestedSigs: SignalCachePart | null = null
    if (cacheRange.start > range[0] || cacheRange.end < Math.min(range[1], RECORDING.dataLength)) {
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
    const loadedSignals = await getSignalUpdatedRange()
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
            clearTimeout(awaitData.timeout as number)
        } else {
            log(postMessage, 'DEBUG', `Timeout reached when waiting for missing signals.`, SCOPE)
        }
        awaitData = null
    }
    requestedSigs = await CACHE.asCachePart()
    // Filter channels, if needed.
    const included = [] as number[]
    // Prioritize include -> only process those channels.
    if (config?.include?.length) {
        for (let i=0; i<requestedSigs.signals.length; i++) {
            if (config.include.indexOf(i) !== -1) {
                included.push(i)
            } else {
                log(postMessage, 'DEBUG', `Not including channel #${i} in requested signals.`, SCOPE)
            }
        }
    } else if (config?.exclude?.length) {
        for (let i=0; i<requestedSigs.signals.length; i++) {
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
    for (let i=0; i<requestedSigs.signals.length; i++) {
        if (included.length && included.indexOf(i) === -1) {
            continue
        }
        const signalForRange = new Float32Array(
            Math.round((range[1] - range[0])*requestedSigs.signals[i].samplingRate)
        ).fill(0.0)
        if (rangeStart === rangeEnd) {
            // The whole range is just gap space.
            responseSigs.push(signalForRange)
            continue
        }
        const startSignalIndex = Math.round((rangeStart - requestedSigs.start)*requestedSigs.signals[i].samplingRate)
        const endSignalIndex = Math.round((rangeEnd - requestedSigs.start)*requestedSigs.signals[i].samplingRate)
        signalForRange.set(requestedSigs.signals[i].data.slice(startSignalIndex, endSignalIndex))
        for (const gap of dataGaps) {
            const startPos = Math.round((gap.start - range[0])*requestedSigs.signals[i].samplingRate)
            const endPos = Math.min(
                startPos + Math.round(gap.duration*requestedSigs.signals[i].samplingRate),
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
const getSignalUpdatedRange = async () => {
    if (!RECORDING.header || !CACHE) {
        return { start: NUMERIC_ERROR_VALUE, end: NUMERIC_ERROR_VALUE }
    }
    const ranges = CACHE.outputSignalUpdatedRanges
    const srs = CACHE.outputSignalSamplingRates
    if (!ranges || !srs) {
        log(postMessage, 'ERROR',
            `Raw signal mutex did not return any signal updated ranges or sampling rates.`,
        SCOPE)
        return { start: NUMERIC_ERROR_VALUE, end: NUMERIC_ERROR_VALUE }
    }
    let highestStart = NUMERIC_ERROR_VALUE
    let lowestEnd = NUMERIC_ERROR_VALUE
    for (let i=0; i<ranges.length; i++) {
        const sr = await srs[i]
        if (!sr) {
            // Empty or missing channel, skip.
            continue
        }
        const range = await ranges[i]
        if (!range) {
            log(postMessage, 'ERROR',
                `Raw signal mutex did not report a valid updated range for signal at index ${i}.`,
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
    const startRecord = start // timeToDataRecordIndex(start)
    const finalRecord = process ? process.target.end
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
            await CACHE.insertSignals(newSignals)
            const updated = await getSignalUpdatedRange()
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
            // Now, there's a chance the signal cache already contained a part of the signal,
            // so adjust next record accordingly.
            if (
                !process || process.direction === LOAD_DIRECTION_FORWARD ||
                // Either first load or loaded preceding part last, now load the following part.
                (process.direction === LOAD_DIRECTION_ALTERNATING && process.start >= start)
            ) {
                nextRecord = timeToDataRecordIndex(updated.end)
            } else if (
                process.direction === LOAD_DIRECTION_BACKWARD ||
                // We loaded a following record previously, so load a preceding record next.
                (process.direction === LOAD_DIRECTION_ALTERNATING && process.start < start)
            ) {
                if (start === 0) {
                    // Start of recording was loaded.
                    return 0
                }
                nextRecord = Math.max(
                    timeToDataRecordIndex(updated.start) - dataChunkRecords,
                    0 // Don't try to load negative index records.
                )
            }
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
                        error: `Combining new and existing signals failed.`
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
const releaseCache = async () => {
    for (const proc of cacheProcesses) {
        proc.continue = false
    }
    cacheProcesses.splice(0)
    CACHE?.releaseBuffers()
    isMutexSetup = false
    CACHE = null
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

/**
 * Initialize mutex buffers.
 * @returns True on success, false on failure.
 */
const setupCache = async (buffer: SharedArrayBuffer, bufferStart: number) => {
    if (isMutexSetup) {
        log(postMessage, 'WARN', `Tried to re-initialize already initialized cache.`, SCOPE)
        return true
    }
    if (!RECORDING.header) {
        log(postMessage, 'ERROR', [`Cannot initialize mutex cache.`, `Study parameters have not been set.`], SCOPE)
        return false
    }
    // Construct a SignalCachePart to initialize the mutex.
    const cacheProps = {
        start: 0,
        end: 0,
        signals: []
    } as SignalCachePart
    for (const sig of RECORDING.header.signalInfo) {
        cacheProps.signals.push({
            data: new Float32Array(),
            samplingRate: isAnnotationSignal(RECORDING.header.dataFormat, sig) ? 0 // Don't cache annotation data.
                          : Math.round(sig.sampleCount/RECORDING.header.dataRecordDuration)
        })
    }
    CACHE = new BiosignalMutex()
    log(postMessage, 'DEBUG', `Initiating EDF worker cache.`, SCOPE)
    await CACHE.initSignalBuffers(cacheProps, RECORDING.dataLength, buffer, bufferStart)
    log(postMessage, 'DEBUG', `EDF loader cache initiation complete.`, SCOPE)
    // Mutex is fully set up.
    isMutexSetup = true
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
    if (CACHE?.outputSignalArrays.length) {
        log(postMessage,
            'ERROR',
            [`Could not set study parameters.`, `Signal cache has already been initialized.`],
        SCOPE)
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
