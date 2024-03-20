/**
 * EpiCurrents EDF processer. This class contains the common methods used both by workerized and direct readers.
 * @package    epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import {
    BiosignalCache,
    BiosignalMutex,
    SignalFileReader,
} from '@epicurrents/core'
import {
    combineSignalParts,
    partsNotCached,
    isAnnotationSignal,
    NUMERIC_ERROR_VALUE,
    sleep,
    MB_BYTES,
} from '@epicurrents/core/dist/util'
import {
    type AppSettings,
    type BiosignalChannel,
    type BiosignalHeaderRecord,
    type ConfigChannelFilter,
    type ReadDirection,
    type SignalCachePart,
    type SignalCacheProcess,
    type SignalDataReader,
    type SignalFilePart,
} from '@epicurrents/core/dist/types'
import { type EdfHeader, type EdfSignalPart } from '#types/edf'
import IOMutex, { type MutexExportProperties } from 'asymmetric-io-mutex'
import EdfDecoder from './EdfDecoder'
import { Log } from 'scoped-ts-log'

const SCOPE = 'EdfProcesser'

const LOAD_DIRECTION_ALTERNATING: ReadDirection = 'alternate'
const LOAD_DIRECTION_BACKWARD: ReadDirection = 'backward'
const LOAD_DIRECTION_FORWARD: ReadDirection = 'forward'
/** Maximum time to wait for missing signals to me loaded, in milliseconds. */
const AWAIT_SIGNALS_TIME = 5000

export default class EdfProcesser extends SignalFileReader implements SignalDataReader {

    protected _channels = [] as BiosignalChannel[]
    protected _decoder = null as EdfDecoder | null
    /** Parsed header of the EDF recording. */
    protected _header = null as EdfHeader | null
    /** A method to pass update messages through. */
    protected _updateCallback = null as ((update: { [prop: string]: unknown }) => void) | null
    /** Settings must be kept up-to-date with the main application. */
    SETTINGS: AppSettings

    constructor (settings: AppSettings) {
        super()
        this.SETTINGS = settings
    }

    get channels () {
        return this._channels
    }

    /**
     * Cache certain header information for use in async, progressive loading.
     * @param header - Parsed EdfHeader.
     * @param dataRecordSize - The size of a single data record in bytes.
     */
    cacheEdfInfo (header: EdfHeader, dataRecordSize: number) {
        this._dataOffset = header.headerRecordBytes
        this._dataUnitCount = header.dataRecordCount
        this._dataUnitDuration = header.dataRecordDuration
        this._dataLength = this._dataUnitCount*this._dataUnitDuration
        this._dataUnitSize = dataRecordSize
        this._chunkUnitCount = this._dataUnitSize*2 < this.SETTINGS.app.dataChunkSize
                                ? Math.floor(this.SETTINGS.app.dataChunkSize/(this._dataUnitSize)) - 1
                                : 1
        this._discontinuous = header.discontinuous
        Log.debug(`Cached EDF info for recording '${header.patientId}'.`, SCOPE)
    }

    async cacheFile (file: File, startFrom: number = 0) {
        // If there is a previous loading task in progress, we need to stop or cancel it first.
        if (this._file) {
            if (file === this._file.data) {
                // Stop loading but keep file data.
                this._stopLoading()
            } else {
                // Cancel loading and start anew.
                this._cancelLoading()
            }
        }
        // Save starting time for debugging.
        this._startTime = Date.now()
        /** The number of data units in the file to be loaded. */
        this._dataUnitCount = Math.floor((file.size - this._dataOffset)/this._dataUnitSize)
        // Signal data is converted from int16 to float32, so it will take double the size of the file itself.
        if (file.size < this.SETTINGS.app.maxLoadCacheSize/2 && !startFrom) {
            Log.info(`Starting progressive loading of a file of size ${(file.size/MB_BYTES).toFixed(2)} MiB.`, SCOPE)
            // Cache the entire file.
            this._file = {
                data: file,
                length: this._dataLength,
                start: 0,
            }
            try {
                this._filePos = 0
                this._loadNextPart()
            } catch (e) {
                Log.error(`Encountered an error when loading signal file.`, SCOPE, e as Error)
            }
        } else {
            Log.error(
                `Not starting from beginning of file or file size ${file.size} bytes exceeds allowed cache size, `+
                `loading file in parts is not yet implemented.`,
            SCOPE)
        }
    }

    /**
     * Cache raw signals from the file at the given URL.
     * @param startFrom - Start caching from the given time point (in seconds) - optional.
     * @returns Success (true/false).
     */
    async cacheSignalsFromUrl (startFrom: number = 0) {
        if (!this._header) {
            Log.error([`Could not cache signals.`, `Study parameters have not been set.`], SCOPE)
            return false
        }
        if (!this.cacheReady) {
            Log.error([`Could not cache signals.`, `Signal cache has not been initialized.`], SCOPE)
            return false
        }
        // Must multiply size by two because of 16 bit int => 32 bit float conversion.
        const totalSignalDataSize = this._dataUnitSize*this._header.dataRecordCount*2
        // Get an array of parts that are in the process of being cached.
        const cacheTargets = this._cacheProcesses.map(proc => proc.target)
        // If we're at the start of the recording and can cache it entirely, just do that.
        if (this.SETTINGS.app.maxLoadCacheSize >= totalSignalDataSize) {
            Log.debug(`Loading the whole recording to cache.`, SCOPE)
            if (startFrom) {
                // Not starting from the beginning, load initial part at location.
                const startRecord = this._timeToDataUnitIndex(startFrom)
                await this.loadAndCachePart(startRecord)
            }
            const requestedPart = {
                start: 0,
                end: this._dataLength,
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
            this._cacheProcesses.push(...newCacheProcs)
            // Start loading missing parts consecutively.
            for (const proc of newCacheProcs) {
                let nextPart = proc.start
                while (nextPart >= 0 && nextPart < proc.target.end) {
                    // Continue loading records, but don't hog the entire thread.
                    if (proc.continue) {
                        [nextPart] = await Promise.all([
                            this.loadAndCachePart(nextPart, proc),
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
            const range = await this._getSignalCacheRange()
            if (range.start === NUMERIC_ERROR_VALUE) {
                Log.error(`The signal cache mutex did not return a valid signal range.`, SCOPE)
                return false
            }
            // First, check if current cache already has this part as one of the "thirds".
            const cacheThird = this._maxDataBlocks/3
            const firstThird = range.start + Math.round(cacheThird)
            const secondThird = range.start + Math.round(cacheThird*2)
            const lastThird = range.start + this._maxDataBlocks
            // Seek the data block the starting point is in.
            let nowInPart = 0
            if (startFrom) {
                for (let i=0; i<this._dataBlocks.length; i++) {
                    if (this._dataBlocks[i].startTime <= startFrom && this._dataBlocks[i].endTime > startFrom) {
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
                for (const proc of this._cacheProcesses) {
                    // Same checks basically.
                    const procFirstThird = proc.target.start + Math.round(cacheThird)
                    const procSecondThird = proc.target.start + Math.round(cacheThird*2)
                    const procLastThird = proc.target.start + this._maxDataBlocks
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
     * Load part of raw recording signals.
     * @param start - Start time as seconds.
     * @param end - End time as seconds.
     * @param unknown - Are the loaded signals unknown, or especially, can they contain uknown gaps. If true, final end time is corrected to contain new gaps.
     * @returns Promise with signals and corrected start and end times.
     */
    async getSignalPart (start: number, end: number, unknown = true) : Promise<EdfSignalPart | null> {
        if (!this._decoder || !this._header || !this._dataUnitSize || !this._dataUnitSize) {
            Log.error("Cannot load file part, study has not been set up yet.", SCOPE)
            return null
        }
        if (this._mutex && !this._isMutexReady) {
            Log.error(`Cannot load file part before signal cache has been initiated.`, SCOPE)
            return null
        }
        if (!this._header.dataRecordDuration) {
            Log.error("Cannot load file part, recording data record duration is zero.", SCOPE)
            return null
        }
        if (start < 0 || start >= this._totalRecordingLength) {
            Log.error(`Requested signal range ${start} - ${end} was out of recording bounds.`, SCOPE)
            return null
        }
        if (start >= end) {
            Log.error(`Requested signal range ${start} - ${end} was empty or invalid.`, SCOPE)
            return null
        }
        if (end > this._totalRecordingLength) {
            end = this._totalRecordingLength
        }
        const priorGaps = start > 0 ? this._getGapTimeBetween(0, start) : 0
        const innerGaps = this._getGapTimeBetween(start, end)
        const fileStart = start - priorGaps
        const fileEnd = end - priorGaps - innerGaps
        // loadPartFromFile performs its own gap detection.
        const filePart = await this.loadPartFromFile(start, end - start)
        if (!filePart) {
            Log.error(`File loader couldn't load EDF part between ${fileStart}-${fileEnd}.`, SCOPE)
            return { signals: [], start: start, end: end }
        }
        const recordsPerSecond = 1/this._header.dataRecordDuration
        // This block is meant to catch possible errors in EdfDecoder and signal interpolation.
        try {
            // Slice a part of the file to process.
            const startPos = Math.round((start - filePart.start)*this._dataUnitSize*recordsPerSecond)
            const endPos = startPos + Math.round((filePart.length)*this._dataUnitSize*recordsPerSecond)
            if (startPos < 0) {
                Log.error(`File starting position is smaller than zero (${startPos})!`, SCOPE)
                throw new Error()
            }
            if (startPos >= endPos) {
                Log.error(`File starting position is greater than ending position (${startPos} > ${endPos})!`, SCOPE)
                throw new Error()
            }
            if (endPos > filePart.data.size) {
                Log.warn(
                    `File ending position is greater than the file size (${endPos} > ${filePart.data.size})!`,
                SCOPE)
                filePart.length = (filePart.data.size - startPos)/(this._dataUnitSize*recordsPerSecond)
            }
            const chunk = filePart.data.slice(startPos, Math.min(endPos, filePart.data.size))
            const chunkBuffer = await chunk.arrayBuffer()
            // Byte offset is always 0, as we slice the data to start from the correct position.
            // Add up all data gaps until this point.
            const edfData = this._decoder.decodeData(
                                    this._header,
                                    chunkBuffer,
                                    0,
                                    (start - priorGaps)*recordsPerSecond,
                                    filePart.length/this._header.dataRecordDuration,
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
                this.cacheNewAnnotations(...edfData.annotations)
            }
            if (edfData.dataGaps.size) {
                this.cacheNewDataGaps(edfData.dataGaps)
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
                const sigSr = this._header.signalInfo[i].sampleCount*recordsPerSecond
                const isAnnotation = isAnnotationSignal(this._header.reserved, this._header.signalInfo[i])
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
            Log.error(`Failed to load signal part between ${start} and ${end}!`, SCOPE, e as Error)
            return null
        }
    }

    async getSignals (range: number[], config?: ConfigChannelFilter) {
        if (!this._header || !this._cache) {
            Log.error("Cannot load signals, signal cache has not been set up yet.", SCOPE)
            return null
        }
        if (this._mutex && !this._isMutexReady) {
            Log.error(`Cannot load signals before signal cache has been initiated.`, SCOPE)
            return null
        }
        if (range[0] === range[1]) {
            Log.error(`Cannot load signals from an empty range ${range[0]} - ${range[1]}.`, SCOPE)
            return null
        }
        // Get current signal cache range.
        const cacheRange = await this._getSignalCacheRange()
        if (cacheRange.start >= cacheRange.end) {
            Log.error(`The signal cache mutex did not return a valid signal range.`, SCOPE)
            return null
        }
        let requestedSigs: SignalCachePart | null = null
        if (cacheRange.start > range[0] || cacheRange.end < Math.min(range[1], this._dataLength)) {
            // Fetch the requested part from signal file.
            try {
                requestedSigs = await this.getSignalPart(range[0], range[1])
                if (!requestedSigs) {
                    return null
                }
            } catch (e) {
                Log.error(`Loading signals for range [${range[0]}, ${range[1]}] failed.`, SCOPE, e as Error)
                return null
            }
        }
        // Make sure we have the requested range of signals.
        const loadedSignals = await this.getSignalUpdatedRange()
        if (loadedSignals.start === NUMERIC_ERROR_VALUE || loadedSignals.end === NUMERIC_ERROR_VALUE) {
            if (!this._cacheProcesses.length) {
                Log.error(`Loading signals for range [${range[0]}, ${range[1]}] failed, cannot read updated signal ranges.`, SCOPE)
                return null
            }
        }
        if (
            (
                (loadedSignals.start > range[0] && loadedSignals.start > 0) ||
                (loadedSignals.end < range[1] && loadedSignals.end < this._totalRecordingLength)
            ) &&
            this._cacheProcesses.length
        ) {
            Log.debug(`Requested signals have not been loaded yet, waiting for ${(AWAIT_SIGNALS_TIME/1000)} seconds.`, SCOPE)
            // Set up a promise to wait for an active data loading process to load the missing data.
            const dataUpdatePromise = new Promise<void>((resolve) => {
                this._awaitData = {
                    range: range,
                    resolve: resolve,
                    timeout: setTimeout(resolve, AWAIT_SIGNALS_TIME),
                }
            })
            await dataUpdatePromise
            if (this._awaitData?.timeout) {
                clearTimeout(this._awaitData.timeout as number)
            } else {
                Log.debug(`Timeout reached when waiting for missing signals.`, SCOPE)
            }
            this._awaitData = null
        }
        requestedSigs = await this._cache.asCachePart()
        // Filter channels, if needed.
        const included = [] as number[]
        // Prioritize include -> only process those channels.
        if (config?.include?.length) {
            for (let i=0; i<requestedSigs.signals.length; i++) {
                if (config.include.indexOf(i) !== -1) {
                    included.push(i)
                } else {
                    Log.debug(`Not including channel #${i} in requested signals.`, SCOPE)
                }
            }
        } else if (config?.exclude?.length) {
            for (let i=0; i<requestedSigs.signals.length; i++) {
                if (config.exclude.indexOf(i) === -1) {
                    included.push(i)
                } else {
                    Log.debug(`Excuding channel #${i} from requested signals.`, SCOPE)
                }
            }
        }
        const responseSigs = {
            start: requestedSigs.start,
            end: requestedSigs.end,
            signals: [],
        } as SignalCachePart
        // Find amount of gap time before and within the range.
        const dataGaps = this.getDataGaps(range)
        const priorGapsTotal = range[0] > 0 ? this._getGapTimeBetween(0, range[0]) : 0
        const innerGapsTotal = this._getGapTimeBetween(range[0], range[1])
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
                responseSigs.signals.push({
                    data: signalForRange,
                    samplingRate: requestedSigs.signals[i].samplingRate,
                })
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
            responseSigs.signals.push({
                data: signalForRange,
                samplingRate: requestedSigs.signals[i].samplingRate,
            })
        }
        return responseSigs
    }

    /**
     * Get the largest start and lowest end updated data range (in seconds) for the signals.
     * @returns Range as { start: number, end: number } measured in seconds or NUMERIC_ERROR_VALUE if an error occurred.
     */
    async getSignalUpdatedRange () {
        if (!this._header || !this._cache) {
            return { start: NUMERIC_ERROR_VALUE, end: NUMERIC_ERROR_VALUE }
        }
        const ranges = this._cache.outputSignalUpdatedRanges
        const srs = this._cache.outputSignalSamplingRates
        if (!ranges || !srs) {
            Log.error(
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
                Log.error(
                    `Raw signal mutex did not report a valid updated range for signal at index ${i}.`,
                SCOPE)
                return { start: NUMERIC_ERROR_VALUE, end: NUMERIC_ERROR_VALUE }
            }
            const tStart = range.start/sr
            const tEnd = range.end/sr
            if (range.start !== IOMutex.EMPTY_FIELD) {
                highestStart = (highestStart === NUMERIC_ERROR_VALUE || tStart > highestStart) ? tStart : highestStart
            } else {
                Log.warn(`Signal #${i} has not updated start position set.`, SCOPE)
            }
            if (range.end !== IOMutex.EMPTY_FIELD) {
                lowestEnd = (lowestEnd === NUMERIC_ERROR_VALUE || tEnd < lowestEnd) ? tEnd : lowestEnd
            } else {
                Log.warn(`Signal #${i} has not updated end position set.`, SCOPE)
            }
        }
        if (highestStart === NUMERIC_ERROR_VALUE && lowestEnd === NUMERIC_ERROR_VALUE) {
            Log.error(`Cannot get ranges of updated signals, cache has no initialized signals.`, SCOPE)
            return { start: NUMERIC_ERROR_VALUE, end: NUMERIC_ERROR_VALUE }
        }
        return { start: this._cacheTimeToRecordingTime(highestStart), end: this._cacheTimeToRecordingTime(lowestEnd) }
    }

    /**
     * Load the next signal part starting from the given record index and cache it.
     * @param start - Data record to start from (inclusive).
     * @param process - Optional cache process to use for information.
     * @returns Timestamp of next record to load (in seconds) or NUMERIC_ERROR_VALUE if an error occurred.
     */
    async loadAndCachePart (start: number, process?: SignalCacheProcess) {
        if (!this._header || !this._cache) {
            Log.debug(`Could not load and cache part, recording or cache was not set up.`, SCOPE)
            return NUMERIC_ERROR_VALUE
        }
        if (start < 0 || start >= this._totalRecordingLength) {
            Log.debug(`Could not load and cache part, start position was out of range.`, SCOPE)
            return NUMERIC_ERROR_VALUE
        }
        const dataChunkRecords = Math.max(
            Math.floor(this.SETTINGS.app.dataChunkSize/this._dataUnitSize),
            1 // Always load at least one record at a time.
        )
        const startRecord = start // this.timeToDataRecordIndex(start)
        const finalRecord = process ? process.target.end
                                    : this._header.dataRecordCount
        let nextRecord = Math.min(
            startRecord + dataChunkRecords,
            finalRecord
        )
        if (nextRecord === startRecord + 1) {
            Log.debug(`Loading complete at record index ${nextRecord}.`, SCOPE)
            // End of the line
            return nextRecord
        }
        try {
            const startTime = this._dataUnitIndexToTime(startRecord)
            const endTime = this._dataUnitIndexToTime(nextRecord)
            const newSignals = await this.getSignalPart(startTime, endTime)
            if (newSignals?.signals.length && (!process || process.continue)) {
                if (this._header.discontinuous) {
                    // Convert start and end time to exclude gaps
                    newSignals.start = this._recordingTimeToCacheTime(newSignals.start)
                    newSignals.end = this._recordingTimeToCacheTime(newSignals.end)
                }
                await this._cache.insertSignals(newSignals)
                const updated = await this.getSignalUpdatedRange()
                if (
                    updated.start === updated.end ||
                    updated.start === NUMERIC_ERROR_VALUE ||
                    updated.end === NUMERIC_ERROR_VALUE
                ) {
                    Log.error(`Inserting new signals to cache failed.`, SCOPE)
                    return NUMERIC_ERROR_VALUE
                }
                // Report signal cache progress and send new annotation and data gap information.
                if (this._updateCallback) {
                    this._updateCallback({
                        action: 'cache-signals',
                        annotations: this.getAnnotations([startTime, endTime]),
                        // Data gap information can change as the file is loaded, they must always be reset.
                        dataGaps: this.getDataGaps(),
                        range: [updated.start, updated.end],
                        success: true,
                    })
                }
                if (this._awaitData) {
                    if (this._awaitData.range[0] >= updated.start && this._awaitData.range[1] <= updated.end) {
                        Log.debug(`Awaited data loaded, resolving.`, SCOPE)
                        this._awaitData.resolve()
                    }
                }
                // Now, there's a chance the signal cache already contained a part of the signal,
                // so adjust next record accordingly.
                if (
                    !process || process.direction === LOAD_DIRECTION_FORWARD ||
                    // Either first load or loaded preceding part last, now load the following part.
                    (process.direction === LOAD_DIRECTION_ALTERNATING && process.start >= start)
                ) {
                    nextRecord = this._timeToDataUnitIndex(updated.end)
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
                        this._timeToDataUnitIndex(updated.start) - dataChunkRecords,
                        0 // Don't try to load negative index records.
                    )
                }
                if (process) {
                    // Update process.
                    if (!combineSignalParts(process, newSignals)) {
                        Log.error(
                            `Failed to combine signal parts ${process.start} - ${process.end} and ` +
                            `${newSignals.start} - ${newSignals.end}.`,
                        SCOPE)
                        return NUMERIC_ERROR_VALUE
                    }
                }
            }
            // Remove possible process as completed.
            if (process) {
                for (let i=0; i<this._cacheProcesses.length; i++) {
                    if (this._cacheProcesses[i] === process) {
                        this._cacheProcesses.splice(i, 1)
                        break
                    }
                }
            }
            return nextRecord
        } catch (e) {
            Log.error(`Failed to get signals`, SCOPE, e as Error)
            return NUMERIC_ERROR_VALUE
        }
    }

    async loadPartFromFile (startFrom: number, dataLength: number): Promise<SignalFilePart> {
        if (!this._url.length) {
            Log.error(`Could not load file part, there is no source URL to load from.`, SCOPE)
            return null
        }
        if (!this._dataUnitSize) {
            Log.error(`Could not load file part, data unit size has not been set.`, SCOPE)
            return null
        }
        // Save starting time for debugging.
        this._startTime = Date.now()
        const unitStart = Math.max(
            0,
            Math.floor(this._timeToDataUnitIndex(startFrom))
        )
        const unitEnd = Math.min(
            Math.ceil(this._timeToDataUnitIndex(startFrom + dataLength)),
            this._dataUnitCount
        )
        const dataStart = this._dataOffset + unitStart*this._dataUnitSize
        const dataEnd = this._dataOffset + unitEnd*this._dataUnitSize
        const getBlob = this._file?.data ? async () => {
            // Slice the data directly from the file.
            return this._file?.data.slice(dataStart, dataEnd) as Blob
        } : async () => {
            // Fetch the data from the file URL.
            const headers = new Headers()
            headers.set('range', `bytes=${dataStart}-${dataEnd - 1}`)
            return await fetch(this._url, {
                headers: headers,
            }).then(response => response.blob()).then(blob => { return blob })
        }
        const startTime = this._dataUnitIndexToTime(unitStart)
        const partLength = this._dataUnitIndexToTime(unitEnd - unitStart)
        const signalFilePart = this._blobToFile(
            await getBlob(),
            `SignalFilePart[${startTime},${startTime + partLength}]`
        )
        // Cache only the visible part.
        return {
            data: signalFilePart,
            length: partLength,
            start: startTime,
        } as SignalFilePart
    }

    setupCache () {
        if (this._fallbackCache) {
            Log.warn(`Tried to re-initialize already initialized EDF signal cache.`, SCOPE)
        } else {
            this._fallbackCache = new BiosignalCache()
        }
        return this._fallbackCache
    }

    /**
     * Set the update callback to get loading updates.
     * @param callback A method that takes the loading update as a parameter.
     */
    setUpdateCallback (callback: ((update: { [prop: string]: unknown }) => void) | null) {
        this._updateCallback = callback
    }

    async setupMutex (buffer: SharedArrayBuffer, bufferStart: number): Promise<MutexExportProperties|null> {
        if (this._mutex) {
            Log.warn(`Tried to re-initialize already initialized EDF signal cache.`, SCOPE)
            return this._mutex.propertiesForCoupling
        }
        if (!this._header) {
            Log.error([`Cannot initialize mutex cache.`, `Study parameters have not been set.`], SCOPE)
            return null
        }
        // Construct a SignalCachePart to initialize the mutex.
        const cacheProps = {
            start: 0,
            end: 0,
            signals: []
        } as SignalCachePart
        for (const sig of this._header.signalInfo) {
            cacheProps.signals.push({
                data: new Float32Array(),
                samplingRate: isAnnotationSignal(this._header.dataFormat, sig) ? 0 // Don't cache annotation data.
                              : Math.round(sig.sampleCount/this._header.dataRecordDuration)
            })
        }
        this._mutex = new BiosignalMutex()
        Log.debug(`Initiating EDF worker cache.`, SCOPE)
        this._mutex.initSignalBuffers(cacheProps, this._dataLength, buffer, bufferStart)
        Log.debug(`EDF loader cache initiation complete.`, SCOPE)
        // Mutex is fully set up.
        this._isMutexReady = true
        return this._mutex.propertiesForCoupling
    }

    /**
     * Set up study params for file loading. This will initializes the shared array buffer for storing
     * the signal data and can only be done once. This method will send the true recording duration
     * to the main thread as part of the worker response object (response.recordingLength).
     * @param header - General biosignal header.
     * @param edfHeader - EDF format-specific header.
     * @param url - Source URL of the EDF data file.
     */
    async setupStudy (header: BiosignalHeaderRecord, edfHeader: EdfHeader, url: string) {
        // Make sure there aren't any cached signals yet.
        if (this._mutex || this._fallbackCache) {
            Log.error(
                [`Could not set study parameters.`, `Signal cache has already been initialized.`],
            SCOPE)
            return false
        }
        this._decoder = new EdfDecoder(undefined, undefined, edfHeader)
        // Store the header for later use.
        this._header = edfHeader
        // Initialize file loader.
        this.cacheEdfInfo(edfHeader, header.dataRecordSize)
        this._url = url
        // Reset possible running cache processes.
        for (let i=0; i<this._cacheProcesses.length; i++) {
            this._cacheProcesses[i].continue = false
            this._cacheProcesses.splice(i, 1)
        }
        if (this._header.discontinuous) {
            // We need to fetch the true file duration from the last data record.
            const filePart = await this.loadPartFromFile((this._dataUnitCount - 1)*this._dataUnitDuration, 1)
            if (filePart) {
                const chunkBuffer = await filePart.data.arrayBuffer()
                // Byte offset is always 0, as we slice the data to start from the correct position.
                // Add up all data gaps until this point.
                const edfData = this._decoder.decodeData(
                                    edfHeader,
                                    chunkBuffer,
                                    0,
                                    0,
                                    filePart.length/this._dataUnitDuration,
                                    0
                                )
                // Remove possible added annotations and data gaps.
                this._annotations.clear()
                this._dataGaps.clear()
                this._totalRecordingLength = (edfData?.dataGaps.get(0) || 0) + this._header.dataRecordDuration
            }
        }
        this._totalRecordingLength = Math.max(this._totalRecordingLength, header.dataRecordCount*header.dataRecordDuration)
        this._dataLength = this._header.dataRecordCount*this._header.dataRecordDuration
        this._dataUnitSize = header.dataRecordSize
        // Construct SharedArrayBuffers and rebuild recording data block structure.
        this._dataBlocks = []
        const dataBlockLen = Math.max(Math.floor(this.SETTINGS.app.dataChunkSize/header.dataRecordSize), 1)
        this._maxDataBlocks = Math.floor(this.SETTINGS.app.maxLoadCacheSize/(dataBlockLen*header.dataRecordSize))
        for (let i=0; i<this._dataUnitCount; i+=dataBlockLen) {
            const endRecord = Math.min(i + dataBlockLen, header.dataRecordCount)
            const startByte = this._dataOffset + i*this._dataUnitSize
            const endByte = this._dataOffset + endRecord*this._dataUnitSize
            this._dataBlocks.push({
                startRecord: i,
                startTime: i*this._dataUnitDuration,
                endRecord: endRecord,
                endTime: endRecord*this._dataUnitDuration,
                startBytePos: startByte,
                endBytePos: endByte,
                data: null,
            })
        }
        return true
    }
}
