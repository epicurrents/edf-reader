/**
 * Epicurrents EDF reader. This class contains the common methods used both by workerized and direct reading.
 * @package    epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericSignalReader } from '@epicurrents/core'
import type {
    AppSettings,
    BiosignalChannel,
    BiosignalHeaderRecord,
    SignalStudyReader,
    SignalSourceOptions,
} from '@epicurrents/core/dist/types'
import type { EdfHeader } from '#types'
import EdfDecoder from './EdfDecoder'
import { Log } from 'scoped-event-log'
import { headerToBiosignalHeader } from '#util'

const SCOPE = 'EdfReader'

export default class EdfReader extends GenericSignalReader implements SignalStudyReader {

    protected _channels = [] as BiosignalChannel[]
    protected _decoder = null as EdfDecoder | null
    /** Parsed header of the EDF recording. */
    protected _fileTypeHeader = null as EdfHeader | null

    constructor (settings: AppSettings) {
        super(Int16Array, settings)
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
        this._totalDataLength = this._dataUnitCount*this._dataUnitDuration
        this._dataUnitSize = dataRecordSize
        this._chunkUnitCount = this._dataUnitSize*2 < this.SETTINGS.app.dataChunkSize
                                ? Math.floor(this.SETTINGS.app.dataChunkSize/(this._dataUnitSize)) - 1
                                : 1
        this._discontinuous = header.discontinuous
        this._header = headerToBiosignalHeader(header)
        Log.debug(`Cached EDF info for recording '${header.localRecordingId}'.`, SCOPE)
    }

    /**
     * @param header - General biosignal header.
     * @param edfHeader - EDF format-specific header.
     * @remarks
     * The true recording duration is resolved here (a discontinuous file needs its last data record
     * read to know it) and returned to the main thread as `response.recordingLength`.
     */
    async setupStudy (source: SignalSourceOptions, header: BiosignalHeaderRecord, edfHeader: EdfHeader) {
        // Make sure there aren't any cached signals yet.
        if (this._mutex || this._fallbackCache) {
            Log.error(
                [`Could not set study parameters.`, `Signal cache has already been initialized.`],
            SCOPE)
            return false
        }
        if (!source.file && !source.url) {
            Log.error(
                [`Could not set study parameters.`, `Neither a source file nor a source URL was given.`],
            SCOPE)
            return false
        }
        this._decoder = new EdfDecoder(undefined, edfHeader)
        // Store the header for later use.
        this._fileTypeHeader = edfHeader
        // Initialize file loader.
        this.cacheEdfInfo(edfHeader, header.dataUnitSize)
        // `cacheEdfInfo` rebuilds the biosignal header from the EDF header, so any correction the
        // loader recorded on the header it passed in is lost unless it is carried over here. A
        // signal marked as stored with an inverted phase is negated as it is read.
        for (let i=0; i<header.signals.length; i++) {
            if (header.signals[i]?.invertPolarity) {
                this._header?.setSignalPolarityInverted(true, i)
            }
        }
        this._url = source.url || ''
        if (source.file) {
            this._setSourceFile(source.file)
        }
        if (source.authHeader) {
            this._authHeader = source.authHeader
        }
        // Reset possible running cache processes.
        for (let i=0; i<this._cacheProcesses.length; i++) {
            this._cacheProcesses[i].continue = false
            this._cacheProcesses.splice(i, 1)
        }
        if (this._fileTypeHeader.discontinuous) {
            // We need to fetch the true file duration from the last data record.
            const filePart = await this._readPartFromFile((this._dataUnitCount - 1)*this._dataUnitDuration, 1)
            if (filePart) {
                const chunkBuffer = await filePart.data.arrayBuffer()
                // Byte offset is always 0, as we slice the data to start from the correct position.
                // Add up all interruptions until this point.
                const edfData = this._decoder.decodeData(
                                    edfHeader,
                                    chunkBuffer,
                                    0,
                                    0,
                                    filePart.dataLength/this._dataUnitDuration,
                                    0
                                )
                // Remove possible added annotations and interruptions.
                this._events.clear()
                this._interruptions.clear()
                this._labels.length = 0
                this._totalRecordingLength = (edfData?.interruptions.get(0) || 0) + this._fileTypeHeader.dataRecordDuration
            }
        }
        this._totalRecordingLength = Math.max(
            this._totalRecordingLength, header.dataUnitCount*header.dataUnitDuration
        )
        this._totalDataLength = this._fileTypeHeader.dataRecordCount*this._fileTypeHeader.dataRecordDuration
        this._dataUnitSize = header.dataUnitSize
        // Construct SharedArrayBuffers and rebuild recording data block structure.
        this._dataBlocks = []
        const dataBlockLen = Math.max(Math.floor(this.SETTINGS.app.dataChunkSize/header.dataUnitSize), 1)
        this._maxDataBlocks = Math.floor(this.SETTINGS.app.maxLoadCacheSize/(dataBlockLen*header.dataUnitSize))
        for (let i=0; i<this._dataUnitCount; i+=dataBlockLen) {
            const endRecord = Math.min(i + dataBlockLen, header.dataUnitCount)
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
                loaded: false,
            })
        }
        return true
    }
}
