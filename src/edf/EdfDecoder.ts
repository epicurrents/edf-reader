/**
 * Original code
 * Author      Jonathan Lurie - http://me.jonahanlurie.fr
 * License     MIT
 * Link        https://github.com/jonathanlurie/edfdecoder
 * Lab         MCIN - http://mcin.ca/ - Montreal Neurological Institute
 *
 * Modifications:
 * @package    @epicurrents/edf-file-loader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericBiosignalHeaders } from '@epicurrents/core'
import {
    concatFloat32Arrays,
    NUMERIC_ERROR_VALUE,
    safeObjectFrom ,
} from '@epicurrents/core/dist/util'
import EdfRecording from './EdfRecording'
import {
    type BiosignalAnnotation,
    type BiosignalFilters,
    type FileDecoder,
} from '@epicurrents/core/dist/types'
import { EdfHeader, EdfSignalInfo } from '#types/edf'
import * as codecutils from 'codecutils'
import Log from 'scoped-ts-log'

const SCOPE = 'EdfDecoder'
/**
* An instance of EdfDecoder is used to decode an EDF file (or rather a buffer extracted from a EDF file).

* To specify the input, use the method `setInput(buffer: ArrayBuffer)`. Decoding is started with the method `decode()`.

* Decoded result can be accessed via the property `output`.

* If the output is `null`, then the parser was not able to decode the file.
*/
export default class EdfDecoder implements FileDecoder {
    private _fileType = 'edf'
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
        const biosigHeaders = new GenericBiosignalHeaders(
            headers.edfPlus ? 'edf+' : 'edf',
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
            highpass: filterHp ? parseFloat(filterHp[1]) : 0,
            lowpass: filterLp ? parseFloat(filterLp[1]) : 0,
            notch: filterNotch ? parseFloat(filterNotch[1]) : 0,
        }
    }
    /**
     * Create a EdfDecoder. If a buffer is provided, it will immediately be set as the input buffer of this decoder.
     * @param buffer - ArrayBuffer to use as input (optional).
     * @param fileType - File type of the input (optional, assumed EDF).
     */
    constructor (buffer?: ArrayBuffer, fileType?: string, header?: EdfHeader) {
        if (buffer) {
            this.setInput(buffer, fileType)
        }
        if (header) {
            this._output = new EdfRecording(header)
        }
    }

    /**
    * The output as an object. The output contains the the header (Object), the raw (digital) signal as a Int16Array
    * and the physical (scaled) signal as a Float32Array.
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

    /**
    * Set the buffer (most likey from a file) that contains some EDF data.
    * @param buffer - Buffer from the EDF file.
    * @param fileType - Buffer file type (assumed EDF, placeholder for possible BDF support in the future).
    */
    setInput (buffer: ArrayBuffer, fileType?: string) {
        this._output = null
        this._inputBuffer = buffer
        if (fileType) {
            this._fileType = fileType
        }
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
    * Decode EDF file data. Can only be called after the header is decoded or a header object provided.
    * @param header - EDF header to use instead of stored header.
    * @param buffer - Buffer to use instead of stored buffer data (optional).
    * @param dataOffset - Byte size of the header or byte index of the record to start from (default is headerRecordSize from header).
    * @param startRecord - Record number at dataOffset (default 0).
    * @param range - Range of records to decode from buffer (optional, but required if a buffer is provided).
    * @param priorOffset - Time offset of the prior data (i.e. total gap time before buffer start, optional, default 0).
    */
    decodeData (
        header: EdfHeader | null,
        buffer?: ArrayBuffer,
        dataOffset?: number,
        startRecord = 0,
        range?: number,
        priorOffset = 0
    ) {
        const dataBuffer = buffer || this._inputBuffer
        const useHeaders = header || this._output?.header
        if (!dataBuffer) {
            Log.error("Cannot decode EDF data: an input buffer must be specified!", SCOPE)
            return null
        }
        if (!useHeaders) {
            Log.error("Cannot decode EDF data: header has not been decoded yet!", SCOPE)
            return null
        }
        const nRecs = useHeaders.dataRecordCount
        if (range && range > nRecs) {
            Log.error("Cannot decode EDF data: given range is out of record bounds!", SCOPE)
            return null
        }
        if (buffer !== undefined && range === undefined) {
            Log.error("Cannot decode EDF data: range must be specified if buffer is specified!", SCOPE)
            return null
        }
        // In case of possible BDF support in the future.
        const SampleType = this._fileType === 'edf' ? Int16Array : Int16Array
        // The raw signal is the digital signal.
        const rawSignals = new Array(useHeaders.signalCount) as Int16Array[][]
        const physicalSignals = new Array(useHeaders.signalCount) as Float32Array[][]
        const nDataRecords = Math.round(range ? range : useHeaders.dataRecordCount)
        const annotations = new Array(nDataRecords) as BiosignalAnnotation[]
        const annotationSignals = [] as number[]
        const annotationProto = {
            annotator: null,
            channels: [],
            duration: 0,
            id: null,
            label: '',
            priority: 0,
            start: 0,
            text: '',
            type: "event"
        } as BiosignalAnnotation
        // Annotation parsing helper methods.
        type AnnotationFields = {
            recordStart: number
            fields: {
                duration: number
                entries: string[]
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
                fields: []
            }
            const fieldProps = {
                startTime: NUMERIC_ERROR_VALUE,
                duration: NUMERIC_ERROR_VALUE,
                entries: [] as string[],
            }
            // Create a view to the underlying buffer.
            const byteArray = codecutils.CodecUtils.extractTypedArray(
                dataBuffer,
                startFrom,
                Uint8Array,
                recordLen
            )
            let fieldStart = startFrom
            let durationNext = false
            for (let i=startFrom; i<startFrom + recordLen; i++) {
                const baIdx = i - startFrom
                if (byteArray[baIdx] === 20) {
                    // Field end byte.
                    if (fieldProps.startTime === NUMERIC_ERROR_VALUE) {
                        const startTime = codecutils.CodecUtils.getString8FromBuffer(
                                            dataBuffer,
                                            i - fieldStart,
                                            fieldStart
                                          )
                        if (!startTime) {
                            throw new Error()
                        }
                        fieldProps.startTime = parseFloat(startTime)
                        if (annotations.recordStart === NUMERIC_ERROR_VALUE && byteArray[baIdx+1] === 20) {
                            annotations.recordStart = fieldProps.startTime
                            // Skip the additional x20 byte.
                            i++
                        }
                    } else if (durationNext) {
                        const duration = codecutils.CodecUtils.getString8FromBuffer(
                                            dataBuffer,
                                            i - fieldStart,
                                            fieldStart
                                         )
                        if (!duration) {
                            throw new Error()
                        }
                        fieldProps.duration = parseFloat(duration)
                        durationNext = false
                    } else {
                        // Decode annotation text part in UTF-8.
                        fieldProps.entries.push(
                            annotationDecoder.decode(dataBuffer.slice(fieldStart, i))
                        )
                    }
                    fieldStart = i+1
                } else if (byteArray[baIdx] === 21) {
                    // Duration delimiter byte.
                    // This delimiter mus follow a start time field.
                    const startTime = codecutils.CodecUtils.getString8FromBuffer(
                                        dataBuffer,
                                        i - fieldStart,
                                        fieldStart
                                      )
                    if (!startTime) {
                        throw new Error()
                    }
                    fieldProps.startTime = parseFloat(startTime)
                    durationNext = true
                    fieldStart = i+1
                } else if (byteArray[baIdx] === 0) {
                    // End of annotation.
                    if (fieldProps.entries.length) {
                        annotations.fields.push({
                            startTime: fieldProps.startTime,
                            duration: fieldProps.duration,
                            entries: [...fieldProps.entries],
                        })
                    }
                    if (byteArray[baIdx+1] === 0) {
                        // No more annotations in this record.
                        break
                    }
                    fieldProps.startTime = NUMERIC_ERROR_VALUE
                    fieldProps.duration = 0
                    fieldProps.entries = []
                    fieldStart = i+1
                }
            }
            return annotations
        }
        // Allocate elements for signals, marking possible EDF Annotations channels.
        for (let i=0; i<useHeaders.signalCount; i++) {
            if (useHeaders.edfPlus && useHeaders.signalInfo[i].label.toLowerCase() === 'edf annotations') {
                annotationSignals.push(i)
            }
            rawSignals[i] = new Array(nDataRecords) as Int16Array[]
            physicalSignals[i] = new Array(nDataRecords) as Float32Array[]
        }
        const dataGaps = new Map<number, number>()
        let startCorrection = 0
        if (dataOffset === undefined) {
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
                const nBytes = nSamples*(SampleType.BYTES_PER_ELEMENT)
                let isAnnotation = false
                // Process annotation signal differently.
                if (useHeaders.edfPlus && sigInfo.label === 'EDF Annotations') {
                    const parsed = getAnnotationFields(dataOffset, nBytes, recAnnotations || undefined)
                    // Save possible discontinuity in signal data
                    if (useHeaders.discontinuous && parsed.recordStart > expectedRecordStart) {
                        dataGaps.set((startRecord + r)*useHeaders.dataRecordDuration, parsed.recordStart - expectedRecordStart)
                        priorOffset += parsed.recordStart - expectedRecordStart
                    } else if (parsed.recordStart < expectedRecordStart + startCorrection) {
                        Log.warn(
                            `EDF file has duplicate record start annotations, file data may be corrupted ` +
                            `(expected start time ${expectedRecordStart} in data record ${r + startRecord}, ` +
                            `got ${parsed.recordStart}).`,
                        SCOPE)
                        // Don't repeat the same warning on all consecutive records.
                        startCorrection = parsed.recordStart - expectedRecordStart
                    }
                    if (recAnnotations) {
                        recAnnotations.fields.push(...parsed.fields)
                    } else {
                        recAnnotations = parsed
                    }
                    isAnnotation = true
                }
                const rawSignal = codecutils.CodecUtils.extractTypedArray(
                    dataBuffer,
                    dataOffset,
                    SampleType,
                    nSamples
                ) as Int16Array
                rawSignals[i][r] = rawSignal
                // Convert digital signal to physical signal.
                const physicalSignal = new Float32Array(rawSignal.length).fill(0)
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
                            start: anno.startTime,
                            duration: anno.duration,
                            label: entry
                        }))
                    }
                }
            }
        }
        if (!buffer) {
            // Refresh output with actual signal data.
            this._output = new EdfRecording(useHeaders, rawSignals, physicalSignals, annotations, dataGaps)
        } else {
            // Add possible parsed annotations and data gaps.
            if (annotations.length) {
                this._output?.addAnnotations(...annotations)
            }
            if (dataGaps.size) {
                this._output?.addDataGaps(dataGaps)
            }
        }
        if (!range || range > 1) {
            return {
                annotations: annotations,
                dataGaps: dataGaps,
                signals: physicalSignals.map((sigSet) => { return concatFloat32Arrays(...sigSet) }),
            }
        } else {
            return {
                annotations: annotations,
                dataGaps: dataGaps,
                signals: physicalSignals.map(sigSet => sigSet[0]),
            }
        }
    }

    /**
    * Decode EDF file header.
    * @param noSignals - Only parse the general part of the header and stop at signal data.
    * @returns Object { header: EdfHeader, size: header size in bytes (= data offset) }.
    */
    decodeHeader (noSignals = false) {
        if (!this._inputBuffer) {
            Log.error("Cannot decode EDF header: an input buffer must be specified!", SCOPE)
            return
        }
        // In case of possible BDF support in the future.
        const SampleType = this._fileType === 'edf' ? Int16Array : Int16Array
        const header = {
            dataFormat: '',
            dataRecordCount: 0,
            dataRecordDuration: 0,
            discontinuous: false,
            edfPlus: false,
            headerRecordBytes: 0,
            localRecordingId: '',
            patientId: '',
            recordByteSize: 0,
            recordingDate: null as null | Date,
            reserved: '',
            signalCount: 0,
            signalInfo: [] as EdfSignalInfo[],
        } as EdfHeader
        let offset = 0
        // Attempt to parse each consecutive field from the header.
        // Vital field parsing errors abort the process in addition to logging an error.
        // EDF field values are padded to standard length with empty spaces, so trim the results.
        Log.debug(`EDF header decoding started.`, SCOPE)
        try {
            // 8 ASCII : version of this data format (0).
            const dataFormat = codecutils.CodecUtils.getString8FromBuffer(this._inputBuffer , 8, offset)
            if (dataFormat === null) {
                throw new Error()
            }
            header.dataFormat = dataFormat.trim()
            Log.debug(`Data format is ${header.dataFormat}.`, SCOPE)
        } catch (e: unknown) {
            Log.error(`Failed to parse data format EDF header field!`, SCOPE, e as Error)
            return
        }
        offset += 8
        try {
            // 80 ASCII : local patient identification.
            const patientId = codecutils.CodecUtils.getString8FromBuffer(this._inputBuffer, 80, offset)
            if (patientId === null) {
                throw new Error()
            }
            header.patientId = patientId.trim()
            Log.debug(`Patient ID is ${header.patientId}.`, SCOPE)
        } catch (e: unknown) {
            Log.error(`Failed to parse patient ID EDF header field!`, SCOPE, e as Error)
        }
        offset += 80
        try {
            // 80 ASCII : local recording identification.
            const localRecordingId = codecutils.CodecUtils.getString8FromBuffer(this._inputBuffer, 80, offset)
            if (localRecordingId === null) {
                throw new Error()
            }
            header.localRecordingId = localRecordingId.trim()
            Log.debug(`Local recording ID is ${header.localRecordingId}.`, SCOPE)
        } catch (e: unknown) {
            Log.error(`Failed to parse local recording ID EDF header field!`, SCOPE, e as Error)
        }
        offset += 80
        try {
            // 8 ASCII : startdate of recording (dd.mm.yy).
            const recStartDate = codecutils.CodecUtils.getString8FromBuffer(this._inputBuffer , 8, offset)?.trim()
            if (!recStartDate) {
                throw Error("Failed to load recording start date from header.")
            }
            offset += 8
            // 8 ASCII : starttime of recording (hh.mm.ss).
            const recStartTime = codecutils.CodecUtils.getString8FromBuffer(this._inputBuffer , 8, offset)?.trim()
            if (!recStartTime) {
                throw Error("Failed to load recording start time from header.")
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
            Log.error(`Failed to parse starting date/time EDF header field!`, SCOPE, e as Error)
            offset += 16
        }
        try {
            // 8 ASCII : number of bytes in header record.
            const hdrRecBytes = codecutils.CodecUtils.getString8FromBuffer(this._inputBuffer , 8, offset)?.trim()
            if (!hdrRecBytes) {
                throw new Error()
            }
            header.headerRecordBytes = parseInt(hdrRecBytes)
            Log.debug(`Header record size is ${header.headerRecordBytes} bytes.`, SCOPE)
        } catch (e: unknown) {
            // Number of bytes can be calculated manually as well.
            Log.error(`Failed to parse EDF header record size field!`, SCOPE, e as Error)
        }
        offset += 8
        try {
            // 44 ASCII : reserved.
            const reserved = codecutils.CodecUtils.getString8FromBuffer(this._inputBuffer , 44, offset)
            if (reserved === null) {
                throw new Error()
            }
            header.reserved = reserved
            if (header.reserved.toUpperCase().startsWith('EDF+')) {
                header.edfPlus = true
                if (header.reserved.toUpperCase().substring(4, 5) === 'D') {
                    header.discontinuous = true
                    Log.debug(`File is using EDF+ specification, discontinuous record.`, SCOPE)
                } else {
                    Log.debug(`File is using EDF+ specification, continuous record.`, SCOPE)
                }
            }
        } catch (e: unknown) {
            Log.error(`Failed to parse reserved EDF header field!`, SCOPE, e as Error)
        }
        offset += 44
        try {
            // 8 ASCII : number of data records.
            // Note: Number of records can be -1 during recording, but currently only offline analysis is supported.
            const dataRecCount = codecutils.CodecUtils.getString8FromBuffer(this._inputBuffer, 8, offset)?.trim()
            if (!dataRecCount) {
                throw new Error()
            }
            header.dataRecordCount = parseInt(dataRecCount)
            Log.debug(`${header.dataRecordCount} data records in file.`, SCOPE)
        } catch (e: unknown) {
            Log.error(`Failed to parse number of data records EDF header field!`, SCOPE, e as Error)
            return
        }
        offset += 8
        try {
            // 8 ASCII : duration of a data record, in seconds.
            const dataRecDuration = codecutils.CodecUtils.getString8FromBuffer(this._inputBuffer , 8, offset)?.trim()
            if (!dataRecDuration) {
                throw new Error()
            }
            header.dataRecordDuration = parseFloat(dataRecDuration)
            Log.debug(`Data recordduration is ${header.dataRecordDuration} seconds.`, SCOPE)
        } catch (e: unknown) {
            Log.error(`Failed to parse duration of data record EDF header field!`, SCOPE, e as Error)
            return
        }
        offset += 8
        try {
            // 4 ASCII : number of signals (ns) in data record.
            const signalCount = codecutils.CodecUtils.getString8FromBuffer(this._inputBuffer , 4, offset)?.trim()
            if (signalCount === null || signalCount === undefined) {
                throw new Error()
            }
            header.signalCount = parseInt(signalCount)
            if (!header.signalCount) {
                Log.warn(`Number of signals in file is zero.`, SCOPE)
            } else {
                Log.debug(`${header.signalCount} signals in file.`, SCOPE)
            }
        } catch (e: unknown) {
            Log.error(`Failed to parse number of signals EDF header field!`, SCOPE, e as Error)
            return
        }
        offset += 4
        // Stop here if signals are not needed.
        if (noSignals) {
            // Generate an "empty" output object from the header information.
            this._output = new EdfRecording(header, [], [])
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
                    const nextField = codecutils.CodecUtils.getString8FromBuffer(
                                        this._inputBuffer,
                                        sectionBytes,
                                        offset
                                      )?.trim()
                    if (!nextField) {
                        throw new Error()
                    }
                    allFields.push(nextField)
                } catch (e: unknown) {
                    Log.error(`Failed to parse signal info at index ${i} from EDF header!`, SCOPE, e as Error)
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
            header.recordByteSize += (header.signalInfo[i].sampleCount || 0)*SampleType.BYTES_PER_ELEMENT
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
        this._output = new EdfRecording(header)
        return header
    }
}
