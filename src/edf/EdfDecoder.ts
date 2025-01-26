/**
 * Original code
 * Author      Jonathan Lurie - http://me.jonahanlurie.fr
 * License     MIT
 * Link        https://github.com/jonathanlurie/edfdecoder
 * Lab         MCIN - http://mcin.ca/ - Montreal Neurological Institute
 *
 * Modifications:
 * @package    epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericAsset, GenericBiosignalHeader } from '@epicurrents/core'
import {
    floatsAreEqual,
    NUMERIC_ERROR_VALUE,
    safeObjectFrom ,
} from '@epicurrents/core/dist/util'
import EdfRecording from './EdfRecording'
import {
    type AnnotationTemplate,
    type BiosignalFilters,
    type FileDecoder,
    type SignalDataGapMap,
} from '@epicurrents/core/dist/types'
import { type EdfHeader, type EdfSignalInfo } from '#types'
import { unpackArray, unpackString } from 'byte-data'
import Log from 'scoped-event-log'

const SCOPE = 'EdfDecoder'
/**
 * EdfDecoder is used to decode an European/Biosemi Data Format file (or rather a buffer extracted from a said file).
 * It supports both the original (EDF/BDF) and the extended specification (EDF+/BDF+).
 *
 * To specify the input, use the method `setInput(buffer: ArrayBuffer)`. Decoding is started with the method `decode()`.
 *
 * Decoded result can be accessed via the property `output`.
 *
 * If the output is `null`, the parser was not able to decode the file.
 */
export default class EdfDecoder implements FileDecoder {
    private _dataFormat = 'edf'
    private _inputBuffer = null as null | ArrayBuffer
    private _output = null as null | EdfRecording
    /**
     * Try to extract the type of signal from the signal info.
     * @param signal - Signal information from the EDF header.
     * @param labelMatchers - A map of labels (RegExp strings) to signal types (optional).
     * @returns Type of the signal or empty string if unsuccessful.
     */
    public static ExtractSignalType (signal: EdfSignalInfo, labelMatchers?: Map<string, string>): string {
        const label = signal.label
        const matchers = labelMatchers
                         ? labelMatchers
                         : new Map<string, string>()
        // Apply a set of default label matchers after the custom matchers.
        const defaultMatchers = [
            // Often all signal labels in an EEG EDF export have "EEG" prefixed or mentioned,
            // so try to match to polygraphic signals first.
            ["emg", "emg"],
            ["eog", "eog"],
            ["ecg|ekg", "ekg"],
            ["eeg", "eeg"],
        ]
        for (const [defLabel, defType] of defaultMatchers) {
            if (!matchers.has(defLabel)) {
                matchers.set(defLabel, defType)
            }
        }
        for (const [matchLabel, matchType] of matchers) {
            if (label.match(new RegExp(matchLabel))) {
                return matchType
            }
        }
        return ""
    }
    /**
     * Convert the given EDF header record into generic biosignal headers.
     * @param headers - Parsed EDF headers.
     * @returns Biosignal header record.
     */
    public static HeaderToBiosignalHeader (headers: EdfHeader) {
        const biosigHeaders = new GenericBiosignalHeader(
            headers.dataFormat,
            headers.patientId,
            headers.patientId,
            headers.dataRecordCount,
            headers.dataRecordDuration,
            headers.recordByteSize,
            headers.signalCount,
            headers.signalInfo.map(s => {
                return {
                    label: s.label,
                    name: s.label,
                    physicalUnit: s.physicalUnit,
                    prefiltering: EdfDecoder.ParsePrefiltering(s.prefiltering),
                    sampleCount: s.sampleCount,
                    samplingRate: s.sampleCount/headers.dataRecordDuration,
                    sensitivity: 0,
                    type: EdfDecoder.ExtractSignalType(s)
                }
            }),
            headers.recordingDate,
            headers.discontinuous,
            [],
        )
        return biosigHeaders
    }
    /**
     * Parse EDF signal prefiltering field per the suggestion in the official EDF spec.
     * @param prefiltering - Prefiltering information as a string.
     * @returns Biosignal filters.
     */
    public static ParsePrefiltering (prefiltering: string): BiosignalFilters {
        const filterHp = prefiltering.match(/HP:([0-9\\.]+)Hz/i)
        const filterLp = prefiltering.match(/LP:([0-9\\.]+)Hz/i)
        const filterNotch = prefiltering.match(/N:([0-9\\.]+)Hz/i)
        return {
            bandreject: [],
            highpass: filterHp ? parseFloat(filterHp[1]) : 0,
            lowpass: filterLp ? parseFloat(filterLp[1]) : 0,
            notch: filterNotch ? parseFloat(filterNotch[1]) : 0,
        }
    }
    /**
     * Create an EdfDecoder. If a buffer is provided, it will immediately be set as the input buffer for this decoder.
     * @param buffer - ArrayBuffer to use as input (optional).
     * @param header - Already decoded EDF header (optional).
     */
    constructor (buffer?: ArrayBuffer, header?: EdfHeader) {
        if (buffer) {
            this.setInput(buffer, header?.dataFormat)
        }
        if (header?.dataFormat) {
            this._dataFormat = header.dataFormat
        }
        if (header) {
            this._output = new EdfRecording(header, undefined, undefined, undefined, undefined, header.dataFormat)
        }
    }

    /**
    * The output as an object. The output contains the the header (Object) and either the raw (digital) signal as an
    * Int16Array or the physical (scaled) signal as a Float32Array.
    * @returns The output.
    */
    get output () {
        return this._output as EdfRecording
    }

    appendInput (buffer: ArrayBuffer) {
        if (!this._inputBuffer) {
            this._inputBuffer = buffer
            return
        }
        const inputView = new Uint8Array(this._inputBuffer)
        const newView = new Uint8Array(buffer)
        const totalView = new Uint8Array(inputView.length + newView.length)
        totalView.set(inputView)
        totalView.set(newView, inputView.length)
        this._inputBuffer = totalView.buffer
    }

    decode () {
        const header = this.decodeHeader()
        if (!header) {
            Log.error(`Decoding EDF file was aborted because of header decoding error.`, SCOPE)
            return null
        }
        const data = this.decodeData(header)?.signals
        if (!data) {
            Log.error(`Decoding EDF file was aborted because of data decoding error.`, SCOPE)
            return null
        }
        return { data: data, header: header }
    }

    /**
    * Decode EDF file data. Can only be called after the header is decoded or a header object is provided.
    * @param header - EDF header to use instead of stored header.
    * @param buffer - Buffer to use instead of stored buffer data (optional).
    * @param dataOffset - Byte size of the header or byte index of the record to start from (default is headerRecordSize from header).
    * @param startRecord - Record number at dataOffset (default 0).
    * @param range - Range of records to decode from buffer (optional, but required if a buffer is provided).
    * @param priorOffset - Time offset of the prior data (i.e. total gap time before buffer start, optional, default 0).
    * @param returnRaw -Return the raw digital signals instead of physical signals (default false).
    * @returns An object holding the decoded signals with possible annotations and data gaps, or null if an error occurred.
    */
    decodeData (
        header: EdfHeader | null,
        buffer?: ArrayBuffer,
        dataOffset = -1,
        startRecord = 0,
        range?: number,
        priorOffset = 0,
        returnRaw = false
    ) {
        const dataBuffer = buffer || this._inputBuffer
        const useHeaders = header || this._output?.header
        if (!useHeaders) {
            Log.error("Cannot decode EDF/BDF data: header has not been decoded yet!", SCOPE)
            return null
        } else if (header) {
            this._dataFormat = header.dataFormat
        }
        let format = this._dataFormat.toUpperCase()
        if (!dataBuffer) {
            Log.error(`Cannot decode ${format} data: an input buffer must be specified!`, SCOPE)
            return null
        }
        const nRecs = useHeaders.dataRecordCount
        if (range && range > nRecs) {
            Log.error(`Cannot decode ${format} data: given range is out of record bounds!`, SCOPE)
            return null
        }
        if (buffer !== undefined && range === undefined) {
            Log.error(`Cannot decode ${format} data: range must be specified if buffer is specified!`, SCOPE)
            return null
        }
        const sampleType = {
            bits: this._dataFormat.startsWith('bdf') ? 24 : 16,
            bytesPerElement: this._dataFormat.startsWith('bdf') ? 3 : 2,
            signed: true,
            float: false,
            be: false,
        }
        const annotationProto = {
            annotator: null,
            background: false,
            channels: [],
            class: 'event',
            duration: 0,
            label: '',
            priority: 0,
            start: 0,
            text: '',
        } as AnnotationTemplate
        // Annotation parsing helper methods.
        type AnnotationFields = {
            /** Data record start time in seconds. */
            recordStart: number
            /** Annotations in this data record. */
            fields: {
                /** Annotation duration on seconds. */
                duration: number
                /** Annotation text parts. */
                entries: string[]
                /** Annotation start time in seconds. */
                startTime: number
            }[]
        }
        // UTF-8 decoder for the annotation text parts.
        const annotationDecoder = new TextDecoder('utf8')
        const getAnnotationFields = (
            startFrom: number,
            recordLen: number,
            existing?: AnnotationFields
        ): AnnotationFields => {
            const annotations = existing || {
                recordStart: NUMERIC_ERROR_VALUE,
                fields: [],
            }
            const fieldProps = {
                startTime: NUMERIC_ERROR_VALUE,
                duration: NUMERIC_ERROR_VALUE,
                entries: [] as string[],
            } as AnnotationFields['fields'][0]
            // Create a view to the underlying buffer.
            const byteArray = new Uint8Array(
                dataBuffer.slice(startFrom, startFrom + recordLen)
            )
            let fieldStart = 0
            let durationNext = false
            for (let i=0; i<recordLen; i++) {
                if (byteArray[i] === 20) {
                    // Field end byte.
                    if (fieldProps.startTime === NUMERIC_ERROR_VALUE) {
                        const startTime = unpackString(byteArray, fieldStart, i)
                        if (!startTime) {
                            throw new Error(`${format} data record start time resolved as falsy.`)
                        }
                        fieldProps.startTime = parseFloat(startTime)
                        if (annotations.recordStart === NUMERIC_ERROR_VALUE && byteArray[i+1] === 20) {
                            annotations.recordStart = fieldProps.startTime
                            // Skip the additional x20 byte.
                            i++
                        }
                    } else if (durationNext) {
                        const duration = unpackString(byteArray, fieldStart, i)
                        if (!duration) {
                            throw new Error(`${format} annotation duration resolved as falsy.`)
                        }
                        fieldProps.duration = parseFloat(duration)
                        durationNext = false
                    } else {
                        // Decode annotation text part in UTF-8.
                        fieldProps.entries.push(
                            annotationDecoder.decode(dataBuffer.slice(startFrom + fieldStart, startFrom + i))
                        )
                    }
                    fieldStart = i + 1
                } else if (byteArray[i] === 21) {
                    // Duration delimiter byte.
                    // This delimiter must follow a start time field.
                    const startTime = unpackString(byteArray, fieldStart, i)
                    if (!startTime) {
                        throw new Error(`${format} annotation start time resolved as falsy.`)
                    }
                    fieldProps.startTime = parseFloat(startTime)
                    durationNext = true
                    fieldStart = i + 1
                } else if (byteArray[i] === 0) {
                    // End of annotation.
                    if (fieldProps.entries.length) {
                        annotations.fields.push({
                            startTime: fieldProps.startTime,
                            duration: fieldProps.duration,
                            entries: [...fieldProps.entries],
                        })
                    }
                    if (byteArray[i+1] === 0) {
                        // No more annotations in this record.
                        break
                    }
                    fieldProps.startTime = NUMERIC_ERROR_VALUE
                    fieldProps.duration = 0
                    fieldProps.entries = []
                    fieldStart = i + 1
                }
            }
            return annotations
        }
        // The raw signal is the digital signal.
        const rawSignals = new Array(useHeaders.signalCount) as Array<number>[][]
        const physicalSignals = new Array(useHeaders.signalCount) as Array<number>[][]
        const nDataRecords = Math.round(range ? range : useHeaders.dataRecordCount)
        const annotations = [] as AnnotationTemplate[]
        const annotationSignals = [] as number[]
        const annoSignalLabel = `${this._dataFormat.substring(0, 3)} annotations`
        // Allocate elements for signals, marking possible EDF Annotations channels.
        for (let i=0; i<useHeaders.signalCount; i++) {
            if (
                useHeaders.isPlus &&
                useHeaders.signalInfo[i].label.toLowerCase() === annoSignalLabel
            ) {
                annotationSignals.push(i)
            }
            rawSignals[i] = new Array(nDataRecords) as Array<number>[]
            physicalSignals[i] = new Array(nDataRecords) as Array<number>[]
        }
        const dataGaps = new Map<number, number>() as SignalDataGapMap
        let startCorrection = 0
        if (dataOffset === -1) {
            dataOffset = useHeaders.headerRecordBytes
        }
        // The raw data is a list of records containing a chunk of each signal.
        for (let r=0; r<nDataRecords; r++) {
            const expectedRecordStart = (startRecord + r)*useHeaders.dataRecordDuration + priorOffset
            // Read the record for each signal.
            let recAnnotations = null as AnnotationFields | null
            for (let i=0; i<useHeaders.signalCount; i++) {
                const sigInfo = useHeaders.signalInfo[i]
                const nSamples = sigInfo.sampleCount
                const nBytes = nSamples*(sampleType.bytesPerElement)
                let isAnnotation = false
                // Process annotation signal differently.
                if (annotationSignals.includes(i)) {
                    const parsed = getAnnotationFields(dataOffset, nBytes, recAnnotations || undefined)
                    const dataPos = (startRecord + r)*useHeaders.dataRecordDuration
                    // Save possible discontinuity in signal data as data gap.
                    // Avoid floating point precision errors.
                    const equalToPrecision = floatsAreEqual(parsed.recordStart, expectedRecordStart, 16)
                    if (useHeaders.discontinuous && parsed.recordStart > expectedRecordStart && !equalToPrecision) {
                        // We must use data time instead of recording time as gap start position because the data record
                        // timestamp cannot always be trusted.
                        dataGaps.set(dataPos, parsed.recordStart - expectedRecordStart)
                        priorOffset += parsed.recordStart - expectedRecordStart
                    } else if (parsed.recordStart < expectedRecordStart + startCorrection && !equalToPrecision) {
                        Log.warn(
                            `${format} file has overlapping record starts, file data may be corrupted ` +
                            `(expected start time ${expectedRecordStart} in data record ${r + startRecord}, ` +
                            `got ${parsed.recordStart}).`,
                        SCOPE)
                        // Don't repeat the same warning on all consecutive records.
                        startCorrection = parsed.recordStart - expectedRecordStart
                    }
                    // Store possible text annotations.
                    if (parsed.fields.length) {
                        if (recAnnotations) {
                            recAnnotations.fields.push(...parsed.fields)
                        } else {
                            recAnnotations = parsed
                        }
                    }
                    isAnnotation = true
                }
                const byteArray = new Uint8Array(dataBuffer)
                const rawSignal = unpackArray(
                    byteArray,
                    sampleType,
                    dataOffset,
                    dataOffset + nBytes
                )
                rawSignals[i][r] = rawSignal
                // Convert digital signal to physical signal.
                const physicalSignal = new Array<number>(rawSignal.length).fill(0)
                if (!isAnnotation) {
                    for (let index=0; index<nSamples; index++) {
                        // https://edfrw.readthedocs.io/en/latest/specifications.html#converting-digital-samples-to-physical-dimensions
                        physicalSignal[index] = sigInfo.unitsPerBit * (rawSignal[index] + sigInfo.digitalOffset)
                            //(
                            //    ((rawSignal[index] - sigInfo.digitalMinimum) / digitalSignalRange )*physicalSignalRange
                            //) + sigInfo.physicalMinimum
                    }
                }
                physicalSignals[i][r] = physicalSignal
                dataOffset += nBytes
            }
            // Add parsed annotations.
            if (recAnnotations) {
                for (const anno of recAnnotations.fields) {
                    for (const entry of anno.entries) {
                        annotations.push(Object.assign({}, annotationProto, {
                            id: GenericAsset.CreateUniqueId(),
                            start: anno.startTime,
                            duration: Math.max(0, anno.duration),
                            label: entry,
                        }))
                    }
                }
            }
        }
        if (!buffer) {
            // Refresh output with actual signal data.
            this._output = new EdfRecording(
                useHeaders,
                returnRaw ? rawSignals : [],
                returnRaw ? [] : physicalSignals,
                annotations,
                dataGaps,
                this._dataFormat
            )
        } else {
            // Add possible parsed annotations and data gaps.
            if (annotations.length) {
                this._output?.addAnnotations(...annotations)
            }
            if (dataGaps.size) {
                this._output?.addDataGaps(dataGaps)
            }
        }
        // If more than one record was requested, we need to concatenate the response signal for each channel from the set of decoded signal records.
        return {
            annotations: annotations,
            dataGaps: dataGaps,
            signals: returnRaw ? rawSignals.map((sigSet) => { return sigSet.flat() })
                               : physicalSignals.map((sigSet) => { return sigSet.flat() }),
        }
    }

    /**
    * Decode EDF file header.
    * @param noSignals - Only parse the general part of the header and stop at signal data.
    * @returns EdfHeader ur null, if an error occurred.
    */
    decodeHeader (noSignals = false) {
        if (!this._inputBuffer) {
            Log.error("Cannot decode EDF/BDF header: an input buffer must be specified!", SCOPE)
            return null
        }
        const header = {
            dataFormat: '',
            dataRecordCount: 0,
            dataRecordDuration: 0,
            discontinuous: false,
            headerRecordBytes: 0,
            isPlus: false,
            localRecordingId: '',
            patientId: '',
            recordByteSize: 0,
            recordingDate: null as null | Date,
            reserved: '',
            signalCount: 0,
            signalInfo: [] as EdfSignalInfo[],
        } as EdfHeader
        let offset = 0
        let format = 'EDF'
        let sampleBytes = 2
        // Attempt to parse each consecutive field from the header.
        // Vital field parsing errors abort the process in addition to logging an error.
        // EDF field values are padded to standard length with empty spaces, so trim the results.
        Log.debug(`EDF header decoding started.`, SCOPE)
        const byteArray = new Uint8Array(this._inputBuffer)
        try {
            // 8 ASCII : version of this data format (0).
            const dataFormat = unpackString(byteArray, offset, offset + 8)
            if (dataFormat === null) {
                throw new Error(`Error when extracting string from buffer.`)
            }
            if (dataFormat.trim() === '0') {
                this._dataFormat = 'edf'
                header.dataFormat = 'edf'
            } else if (byteArray[offset] === 255 && dataFormat.substring(1).trim() === 'BIOSEMI') {
                this._dataFormat = 'bdf'
                header.dataFormat = 'bdf'
                format = 'BDF'
                sampleBytes = 3
            } else {
                throw new Error(`Unsupported data format ${dataFormat.trim()}.`)
            }
            Log.debug(`Data format is ${format}.`, SCOPE)
        } catch (e: unknown) {
            Log.error(`Failed to parse data format ${format} header field!`, SCOPE, e as Error)
            return null
        }
        offset += 8
        try {
            // 80 ASCII : local patient identification.
            const patientId = unpackString(byteArray, offset, offset + 80)
            if (patientId === null) {
                throw new Error(`Error when extracting string from buffer.`)
            }
            header.patientId = patientId.trim()
            Log.debug(`Patient ID is ${header.patientId}.`, SCOPE)
        } catch (e: unknown) {
            Log.error(`Failed to parse patient ID ${format} header field!`, SCOPE, e as Error)
        }
        offset += 80
        try {
            // 80 ASCII : local recording identification.
            const localRecordingId = unpackString(byteArray, offset, offset + 80)
            if (localRecordingId === null) {
                throw new Error(`Error when extracting string from buffer.`)
            }
            header.localRecordingId = localRecordingId.trim()
            Log.debug(`Local recording ID is ${header.localRecordingId}.`, SCOPE)
        } catch (e: unknown) {
            Log.error(`Failed to parse local recording ID ${format} header field!`, SCOPE, e as Error)
        }
        offset += 80
        try {
            // 8 ASCII : startdate of recording (dd.mm.yy).
            const recStartDate = unpackString(byteArray, offset, offset + 8)?.trim()
            if (recStartDate === undefined) {
                throw Error(`Error when extracting date string from buffer.`)
            }
            if (!recStartDate.length) {
                throw Error(`Date value is empty.`)
            }
            offset += 8
            // 8 ASCII : starttime of recording (hh.mm.ss).
            const recStartTime = unpackString(byteArray, offset, offset + 8)?.trim()
            if (recStartTime === null) {
                throw Error(`Error when extracting time string from buffer.`)
            }
            if (!recStartTime?.length) {
                throw Error(`Time value is empty.`)
            }
            offset += 8
            const date = recStartDate.split(".")
            // 1985 breakpoint.
            if (parseInt(date[2]) >= 85) {
                date[2] = `19${date[2]}`
            } else {
                date[2] = `20${date[2]}`
            }
            const time = recStartTime.split(".")
            header.recordingDate = new Date(
                parseInt(date[2]),
                parseInt(date[1]) - 1,
                parseInt(date[0]),
                parseInt(time[0]),
                parseInt(time[1]),
                parseInt(time[2]),
                0
            )
            Log.debug(`Starting datetime is ${header.recordingDate.toDateString()}.`, SCOPE)
        } catch (e: unknown) {
            Log.error(`Failed to parse starting date/time ${format} header field!`, SCOPE, e as Error)
            offset += 16
        }
        try {
            // 8 ASCII : number of bytes in header record.
            const hdrRecBytes = unpackString(byteArray, offset, offset + 8)?.trim()
            if (hdrRecBytes === undefined) {
                throw Error(`Error when extracting record size string from buffer.`)
            }
            if (!hdrRecBytes.length) {
                throw Error(`Record size field is empty.`)
            }
            header.headerRecordBytes = parseInt(hdrRecBytes)
            Log.debug(`Header record size is ${header.headerRecordBytes} bytes.`, SCOPE)
        } catch (e: unknown) {
            // Number of bytes can be calculated manually as well.
            Log.error(`Failed to parse ${format} header record size field!`, SCOPE, e as Error)
        }
        offset += 8
        try {
            // 44 ASCII : reserved.
            const reserved = unpackString(byteArray, offset, offset + 44)
            if (reserved === null) {
                throw Error(`Error when extracting reserved string from buffer.`)
            }
            header.reserved = reserved.trim()
            if (header.reserved.toUpperCase().startsWith(`${format}+`)) {
                header.isPlus = true
                header.dataFormat += '+'
                format += '+'
                if (header.reserved.toUpperCase().substring(4, 5) === 'D') {
                    header.discontinuous = true
                    Log.debug(`File is using ${format} specification, discontinuous record.`, SCOPE)
                } else {
                    Log.debug(`File is using ${format} specification, continuous record.`, SCOPE)
                }
            }
        } catch (e: unknown) {
            Log.error(`Failed to parse reserved ${format} header field!`, SCOPE, e as Error)
        }
        offset += 44
        try {
            // 8 ASCII : number of data records.
            // Note: Number of records can be -1 during recording, but currently only offline analysis is supported.
            const dataRecCount = unpackString(byteArray, offset, offset + 8)?.trim()
            if (dataRecCount === undefined) {
                throw Error(`Error when extracting data record count string from buffer.`)
            }
            if (!dataRecCount.length) {
                throw Error(`Data record count is empty.`)
            }
            header.dataRecordCount = parseInt(dataRecCount)
            if (!header.dataRecordCount) {
                throw Error(`Data record count is zero.`)
            }
            Log.debug(`${header.dataRecordCount} data records in file.`, SCOPE)
        } catch (e: unknown) {
            Log.error(`Failed to parse number of data records ${format} header field!`, SCOPE, e as Error)
            return null
        }
        offset += 8
        try {
            // 8 ASCII : duration of a data record, in seconds.
            const dataRecDuration = unpackString(byteArray, offset, offset + 8)?.trim()
            if (dataRecDuration === undefined) {
                throw Error(`Error when extracting data record duration string from buffer.`)
            }
            if (!dataRecDuration.length) {
                throw Error(`Data record duration is empty.`)
            }
            header.dataRecordDuration = parseFloat(dataRecDuration)
            if (!header.dataRecordDuration) {
                throw Error(`Data record duration is zero.`)
            }
            Log.debug(`Data recordduration is ${header.dataRecordDuration} seconds.`, SCOPE)
        } catch (e: unknown) {
            Log.error(`Failed to parse duration of data record ${format} header field!`, SCOPE, e as Error)
            return null
        }
        offset += 8
        try {
            // 4 ASCII : number of signals (ns) in data record.
            const signalCount = unpackString(byteArray, offset, offset + 4)?.trim()
            if (signalCount === undefined) {
                throw Error(`Error when extracting signal count string from buffer.`)
            }
            if (!signalCount.length) {
                throw Error(`Signal count value is empty.`)
            }
            header.signalCount = parseInt(signalCount)
            if (!header.signalCount) {
                Log.warn(`Number of signals in file is zero.`, SCOPE)
            } else {
                Log.debug(`${header.signalCount} signals in file.`, SCOPE)
            }
        } catch (e: unknown) {
            Log.error(`Failed to parse number of signals ${format} header field!`, SCOPE, e as Error)
            return null
        }
        offset += 4
        // Stop here if signals are not needed.
        if (noSignals) {
            // Generate an "empty" output object from the header information.
            this._output = new EdfRecording(header, [], [], undefined, undefined, this._dataFormat)
            return header
        }
        /** Parse signal info fields. */
        const getAllSections = (sectionBytes: number) => {
            if (!this._inputBuffer) {
                return []
            }
            const allFields = []
            for (let i=0; i<header.signalCount; i++) {
                try {
                    const nextField = unpackString(
                                        byteArray,
                                        offset,
                                        offset + sectionBytes,
                                      )?.trim()
                    if (nextField === undefined) {
                        throw Error(`Error when extracting field string from buffer.`)
                    }
                    allFields.push(nextField)
                } catch (e: unknown) {
                    Log.error(`Failed to parse signal info at index ${i} from ${format} header!`, SCOPE, e as Error)
                    return []
                }
                offset += sectionBytes
            }
            return allFields
        }
        const signalInfoArrays = {
            // ns * 16 ASCII : ns * label (e.g. EEG Fpz-Cz or Body temp).
            label: getAllSections(16) || '--',
            // ns * 80 ASCII : ns * transducer type (e.g. AgAgCl electrode).
            transducerType: getAllSections(80) || '--',
            // ns * 8 ASCII : ns * physical dimension (e.g. uV or degreeC).
            physicalUnit: getAllSections(8) || '--',
            // ns * 8 ASCII : ns * physical minimum (e.g. -500 or 34).
            physicalMinimum: getAllSections(8) || '0',
            // ns * 8 ASCII : ns * physical maximum (e.g. 500 or 40).
            physicalMaximum: getAllSections(8) || '0',
            // ns * 8 ASCII : ns * digital minimum (e.g. -2048).
            digitalMinimum: getAllSections(8) || '0',
            // ns * 8 ASCII : ns * digital maximum (e.g. 2047).
            digitalMaximum: getAllSections(8) || '0',
            // ns * 80 ASCII : ns * prefiltering (e.g. HP:0.1Hz LP:75Hz).
            prefiltering: getAllSections(80) || '--',
            // ns * 8 ASCII : ns * nr of samples in each data record.
            sampleCount: getAllSections(8) || '0',
            // ns * 32 ASCII : ns * reserved.
            reserved: getAllSections(32) || '',
        }
        const signalInfo = [] as EdfSignalInfo[]
        header.signalInfo = signalInfo
        for (let i=0; i<header.signalCount; i++) {
            const digMax = parseInt(signalInfoArrays.digitalMaximum[i])
            const digMin = parseInt(signalInfoArrays.digitalMinimum[i])
            const physMax = parseFloat(signalInfoArrays.physicalMaximum[i])
            const physMin = parseFloat(signalInfoArrays.physicalMinimum[i])
            const unitsPerBit = (physMax - physMin)/(digMax - digMin)
            const samplingRate = parseInt(signalInfoArrays.sampleCount[i])/header.dataRecordDuration
            signalInfo.push(safeObjectFrom({
                digitalMaximum: digMax,
                digitalMinimum: digMin,
                digitalOffset: physMax/unitsPerBit - digMax,
                label: signalInfoArrays.label[i],
                physicalMaximum: physMax,
                physicalMinimum: physMin,
                physicalUnit: signalInfoArrays.physicalUnit[i],
                prefiltering: signalInfoArrays.prefiltering[i],
                reserved: signalInfoArrays.reserved[i],
                sampleCount: parseInt(signalInfoArrays.sampleCount[i]),
                samplingRate: signalInfoArrays.label[i] !== 'EDF Annotations' ? samplingRate : 0,
                transducerType: signalInfoArrays.transducerType[i],
                unitsPerBit: unitsPerBit,
            }) as EdfSignalInfo)
            header.recordByteSize += (header.signalInfo[i].sampleCount || 0)*sampleBytes
            Log.debug([
                    `Signal [${i}]:`,
                    `Label: ${signalInfoArrays.label[i]},`,
                    `Sampling rate: ${samplingRate},`,
                    `Physical unit: ${signalInfoArrays.physicalUnit[i]}.`,
                ], SCOPE
            )
        }
        if (header.headerRecordBytes !== offset) {
            Log.warn(
                `Calculated data offset ${offset} does not match header record size ${header.headerRecordBytes}.`,
            SCOPE)
        }
        // Generate an "empty" output object from the header information.
        this._output = new EdfRecording(header, undefined, undefined, undefined, undefined, this._dataFormat)
        return header
    }

    /**
    * Set the buffer (most likey from a file) that contains some EDF data.
    * @param buffer - Buffer from the EDF file.
    * @param dataFormat - Buffer file type (assumed EDF, placeholder for possible BDF support in the future).
    */
    setInput (buffer: ArrayBuffer, dataFormat?: string) {
        this._output = null
        this._inputBuffer = buffer
        if (dataFormat) {
            this._dataFormat = dataFormat
        }
    }
}
