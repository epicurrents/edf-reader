/**
 * Epicurrents EDF encoder. This class can be used to encode signal data into a custom EDF format.
 * @package    epicurrents/edf-reader
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import { headerToBiosignalHeader } from '#util'
import type {
    EdfFooter,
    EdfHeader,
    EdfRecordingType,
    FileFormatEncoder,
} from '#types'
import type {
    AnnotationTemplate,
    BiosignalHeaderRecord,
    BiosignalHeaderSignal,
} from '@epicurrents/core/dist/types'
import { safeObjectFrom } from '@epicurrents/core/dist/util'
import { Log } from 'scoped-event-log'

const SCOPE = 'EdfEncoder'

export default class EdfEncoder implements FileFormatEncoder {
    /** Buffers that are ready to be written into the EDF file. */
    #buffers = {
        footer: null as ArrayBuffer | null,
        header: null as ArrayBuffer | null,
        signals: null as ArrayBuffer | null,
    }
    #digitalSignals: Int16Array[] = []
    #edfHeader: EdfHeader | null = null
    /** Digital signal buffer from a source EDF recording. */
    #edfSignalBuffer: Int16Array | null = null
    #footer = safeObjectFrom({
        annotations: [],
        channels: [],
        dataGaps: [],
        modality: 'eeg',
        recordingDate: null,
        version: '1.0',
        videos: [],
    }) as EdfFooter
    #header: BiosignalHeaderRecord | null = null
    /** Properties are locked from changing before writing is complete. */
    #locked = false
    #physicalSignals: Float32Array[] = []
    #recordingType: EdfRecordingType
    /** List of signal indices (in EDF header) that should be included. Empty array means to include all. */
    #signalsToInclude = [] as number[]
    /** Maximum value of a signed 16-bit integer. */
    static readonly DIGITAL_MAX = 32767
    /** Minimum value of a signed 16-bit integer. */
    static readonly DIGITAL_MIN = -32768
    /** ASCII code for the empty space to use to pad header fields. */
    static readonly EMPTY_SPACE = 32
    static SAMPLE_SIZE = 2 // Each sample is 2 bytes by default (Int16).
    /** TAL field delimiter code. */
    static readonly TAL_DELIMITER = 20
    // TAL code for separating start time from duration is 21, but it's not supported by this encoder.

    protected _validLabels = new Set<RegExp>([
        /^edf annotations$/i,
    ])
    protected _validPrefilters = new Set<RegExp>([
        /^((hp|lp|n)[:-=\s]\d\d?\d?\.?\d?\d?\d?hz[;_\s]?)+$/i,
    ])
    protected _validTransducers = new Set<RegExp>([
        /^agagcl$/i,
    ])
    /**
     * Physical amplitude ranges for encoded signals as [minimum, maximum] in the physical unit of the signal.
     * The final resolution of the signal is `(max-min)/65535` units.
     *
     * First, a match for the signal index is tried and failing that, a match for the signal type.
     * If no match is found, a default range of 0 to 1 is used.
     */
    amplitudeRanges = new Map<number|string, [number, number]>([
        ['eeg', [-5000, 5000]],
        ['emg', [-5000, 5000]],
        ['ekg', [-50000, 50000]],
        ['eog', [-5000, 5000]],
    ])
    /**
     * Create a new EDF encoder.
     * @param recordingType The type of the recording (e.g. 'eeg').
     */
    constructor (recordingType: EdfRecordingType) {
        this.#recordingType = recordingType
        this.#footer.modality = recordingType
    }

    get #includedSignals (): Map<number, BiosignalHeaderSignal> {
        // If the header is not set, return an empty array.
        if (!this.#header) {
            Log.error(`Cannot get included signals, current header property is empty.`, SCOPE)
            return new Map()
        }
        const includedSignals = new Map<number, BiosignalHeaderSignal>()
        for (let i = 0; i<this.#header.signalCount; i++) {
            if (
                // Never include the EDF annotations signal.
                this.#header.signals[i].label.toLowerCase() !== 'edf annotations'
                && (!this.#signalsToInclude.length || this.#signalsToInclude.includes(i))
            ) {
                if (this.#header.signals[i]) {
                    includedSignals.set(i, this.#header.signals[i])
                } else {
                    Log.error(`Signal index ${i} is not found in the header signals.`, SCOPE)
                    return new Map()
                }
            }
        }
        return includedSignals
    }

    #getPhysicalRangeFor (index: number, signal: BiosignalHeaderSignal): [number, number] {
        // Try to get the physical range for the signal based on its index.
        const range = this.amplitudeRanges.get(index)
                      || this.amplitudeRanges.get(signal.modality)
                      || [0, 1] // Default range if not found.
        return range
    }

    #updateEdfHeader (header?: Partial<EdfHeader>) {
        if (!this.#edfHeader) {
            Log.debug(`updateEdfHeader called without a pre-existing header, creating a new one.`, SCOPE)
            this.createHeader(header)
            return
        }
        if (this.#locked) {
            Log.error(`Cannot update EDF header, header properties are locked.`, SCOPE)
            return
        }
        Object.assign(this.#edfHeader, header || {})
        this.#edfHeader.recordByteSize = this.#edfHeader.signalInfo.reduce(
                                    // Each sample is 2 bytes (Int16) and each record one second long.
            (acc, signal) => acc + ((signal.sampleCount/this.#edfHeader!.dataRecordDuration)*2),
            0.
        )
        this.#header = headerToBiosignalHeader(this.#edfHeader)
        this.#updateFooter()
    }

    #updateFooter (properties?: Partial<EdfFooter>) {
        if (this.#locked) {
            Log.error(`Cannot update footer, header properties are locked.`, SCOPE)
            return
        }
        if (properties) {
            // Update the footer properties with the given properties.
            Object.assign(this.#footer, properties)
        } else if (this.#header) {
            // If no properties are given, take properties from the header.
            this.#footer.recordingDate = this.#header.recordingStartTime
                ? this.#header.recordingStartTime.toISOString()
                : '2000-01-01T00:00:00.000Z' // Default date.
            this.#footer.annotations = this.#header.annotations || []
            this.#footer.dataGaps = Array.from(this.#header.dataGaps.entries()) || []
        }
        // Update the channels in the footer based on the included signals.
        this.#footer.channels = []
        for (const [idx, signal] of this.#includedSignals) {
            const [physMin, physMax] = this.#getPhysicalRangeFor(idx, signal)
            this.#footer.channels.push(safeObjectFrom({
                label: signal.label,
                modality: signal.modality,
                name: signal.name,
                physicalMin: physMin,
                physicalMax: physMax,
                preFilters: signal.prefiltering || { highpass: null, lowpass: null, notch: null },
                sampleCount: signal.sampleCount || 0,
                samplesPerRecord: signal.sampleCount || 0,
                samplingRate: signal.samplingRate || 0,
                scale: 0,
                sensitivity: signal.sensitivity || 0,
                unit: signal.physicalUnit || '',
            }))
        }
    }

    async #writeFooterBuffer (anonymize = false): Promise<ArrayBuffer | null> {
        this.#buffers.footer = null
        if (!this.#locked) {
            Log.error(`Cannot write footer buffer, header properties are not locked.`, SCOPE)
            return null
        }
        if (!this.#footer) {
            Log.error(`Cannot write footer buffer, current footer property is empty.`, SCOPE)
            return null
        }
        this.#footer.version = '1.0' // Set the version to 1.0 by default.
        this.#footer.modality = this.#recordingType // Set the modality to the recording type.
        if (anonymize) {
            // Perform anonymization by removing sensitive information.
            this.#footer.recordingDate = "2000-01-01T00:00:00.000Z" // Default date.
            this.#footer.annotations = this.#footer.annotations.filter(anno => {
                // Only include annotations with valid labels.
                if (!this._validLabels.values().map(l => anno.label.match(l)).some(m => m)) {
                    return false
                }
                return true
            }).map(anno => {
                return {
                    ...anno,
                    // Remove text part from annotations.
                    text: ''
                }
            })
        }
        // Create a JSON string from the footer object and covert to an UTF-8 byte array.
        const footerBytes = new TextEncoder().encode(JSON.stringify(this.#footer))
        // Calculate the size of the footer in KB.
        const footerSize = Math.ceil(footerBytes.length / 1024)
        // Create an ArrayBuffer for the footer.
        const footerBuffer = new ArrayBuffer(footerSize * 1024)
        const footerView = new Uint8Array(footerBuffer)
        // Write the footer bytes into the buffer.
        for (let i = 0; i < footerBytes.length; i++) {
            footerView[i] = footerBytes[i]
        }
        this.#buffers.footer = footerBuffer
        return footerBuffer
    }

    async #writeHeaderBuffer (anonymize = false): Promise<ArrayBuffer | null> {
        this.#buffers.header = null
        if (!this.#header) {
            Log.error(`Cannot write header buffer, current header property is empty.`, SCOPE)
            return null
        }
        if (!this.#locked) {
            Log.error(`Cannot write header buffer, header properties are not locked.`, SCOPE)
            return null
        }
        // Calculate the header size.
        let headerBytes = 256 // Base size for EDF header.
        // Each signal has 256 bytes of info; an empty #signalsToInclude array means all are to be included.
        headerBytes += (this.#signalsToInclude.length || this.#header.signalCount) * 256
        const headerBuffer = new ArrayBuffer(headerBytes)
        const headerView = new DataView(headerBuffer)
        // Write the header data into the buffer.
        let offset = 0
        // Write the EDF version.
        const version = '0'
        for (let i = 0; i < 8; i++) {
            // Write the EDF version, padded with spaces if necessary.
            headerView.setUint8(offset++, version.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
        }
        // Write the local patient ID.
        const patientId = this.#header.patientId || 'Anonymous'
        for (let i = 0; i < 80; i++) {
            headerView.setUint8(offset++, patientId.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
        }
        // Write the local recording ID.
        const recordingId = this.#header.recordingId || 'Epicurrents EDF'
        for (let i = 0; i < 80; i++) {
            headerView.setUint8(offset++, recordingId.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
        }
        // Write the recording date.
        const headerDateTime = this.#header.recordingStartTime?.toISOString().replace(/[-:T]/g, '.').slice(0, 14)
        const recordingDateTime = headerDateTime && !anonymize
                                ? `${headerDateTime.slice(6, 8)}.${headerDateTime.slice(4, 6)}.${
                                    parseInt(headerDateTime.slice(0,4)) < 2084 ? headerDateTime.slice(2, 4) : 'yy'
                                    }${
                                        headerDateTime.slice(8, 10)
                                    }.${
                                        headerDateTime.slice(10, 12)
                                    }.${
                                        headerDateTime.slice(12, 14)
                                    }`
                                : '01.01.0000.00.00'
        for (let i = 0; i < 16; i++) {
            headerView.setUint8(offset++, recordingDateTime.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
        }
        // Compute the byte size of the entire recording.
        const totalByteSize = headerBytes + this.#header.dataUnitCount*this.#header.dataUnitSize
        // Get the footer size in KB.
        const footerBuffer = this.#buffers.footer || (await this.#writeFooterBuffer())
        if (!footerBuffer) {
            Log.error(`Failed to write footer buffer for size estimation.`, SCOPE)
            return null
        }
        // Store the footer size in KB.
        const footerSize = Math.ceil(footerBuffer.byteLength/1024)
        // Write the reserved field for EDF+ files, keep empty for normal EDF files.
        const reserved = this.#header.discontinuous
                       ? `EDF+D EC:${totalByteSize}:${footerSize}`
                       : `EDF EC:${totalByteSize}:${footerSize}`
        for (let i = 0; i < 44; i++) {
            headerView.setUint8(offset++, reserved.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
        }
        // Write the number of data records.
        const dataRecordCount = `${this.#header.dataUnitCount || 0}`
        for (let i = 0; i < 8; i++) {
            headerView.setUint8(offset++, dataRecordCount.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
        }
        // Write the duration of each data record in seconds.
        const dataRecordDuration = `${this.#header.dataUnitDuration || 0}`
        for (let i = 0; i < 8; i++) {
            headerView.setUint8(offset++, dataRecordDuration.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
        }
        // Write the number of signals.
        const signalCount = `${this.#signalsToInclude.length || this.#header.signalCount || 0}`
        for (let i = 0; i < 4; i++) {
            headerView.setUint8(offset++, signalCount.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
        }
        const includedSignals = this.#includedSignals // Only generate the map once.
        if (!includedSignals.size) {
            Log.error(`Cannot write header buffer, no signals to include.`, SCOPE)
            return null
        }
        // Write the labels for each signal, using the included channels.
        for (const [_idx, signal] of includedSignals) {
            // Write the label; if anonymize is true, use '??' for unknown labels.
            const label = !anonymize || this._validLabels.values().map(l => signal.label.trim().match(l)).some(m => m)
                        ? signal.label
                        : '??'
            for (let i = 0; i < 16; i++) {
                headerView.setUint8(offset++, label.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
            }
        }
        // Write the transducer names.
        for (const [_idx, signal] of includedSignals) {
            // Write the transducer; if anonymize is true, use an empty string for unknown transducers.
            const transducer = !anonymize || this._validTransducers.values().map(
                                                t => signal.sensor.match(t)
                                             ).some(m => m)
                             ? signal.sensor
                             : ''
            for (let i = 0; i < 80; i++) {
                headerView.setUint8(offset++, transducer.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
            }
        }
        // Write the physical units.
        for (const [_idx, signal] of includedSignals) {
            for (let i = 0; i < 8; i++) {
                headerView.setUint8(offset++, signal.physicalUnit.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
            }
        }
        // Write the physical minimum and maximum values.
        for (const [idx, signal] of includedSignals) {
            const physMin = this.#getPhysicalRangeFor(idx, signal)[0]
            for (let i = 0; i < 8; i++) {
                headerView.setUint8(offset++, (physMin.toString().charCodeAt(i) || EdfEncoder.EMPTY_SPACE))
            }
        }
        for (const [idx, signal] of includedSignals) {
            let physMax = this.#getPhysicalRangeFor(idx, signal)[1]
            for (let i = 0; i < 8; i++) {
                headerView.setUint8(offset++, (physMax.toString().charCodeAt(i) || EdfEncoder.EMPTY_SPACE))
            }
        }
        // Write the digital minimum and maximum values.
        for (const [_idx, _signal] of includedSignals) {
            for (let i = 0; i < 8; i++) {
                headerView.setUint8(
                    offset++,
                    (EdfEncoder.DIGITAL_MIN.toString().charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
                )
            }
        }
        for (const [_idx, _signal] of includedSignals) {
            for (let i = 0; i < 8; i++) {
                headerView.setUint8(
                    offset++,
                    (EdfEncoder.DIGITAL_MAX.toString().charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
                )
            }
        }
        // Write prefiltering information.
        for (const [_idx, signal] of includedSignals) {
            // Write the prefiltering; if anonymize is true, use an empty string for unknown prefiltering.
            const prefiltering = []
            if (signal.prefiltering) {
                if (signal.prefiltering.highpass !== null) {
                    prefiltering.push(`HP:${signal.prefiltering.highpass}Hz`)
                }
                if (signal.prefiltering.lowpass !== null) {
                    prefiltering.push(`LP:${signal.prefiltering.lowpass}Hz`)
                }
                if (signal.prefiltering.notch !== null) {
                    prefiltering.push(`N:${signal.prefiltering.notch}Hz`)
                }
            }
            for (let i = 0; i < 80; i++) {
                headerView.setUint8(offset++, prefiltering.join(' ').charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
            }
        }
        // Write the number of samples per data record.
        for (const [_idx, signal] of includedSignals) {
            const sampleCount = (signal.sampleCount || 0).toString()
            for (let i = 0; i < 8; i++) {
                headerView.setUint8(offset++, (sampleCount.toString().charCodeAt(i) || EdfEncoder.EMPTY_SPACE))
            }
        }
        // Write the reserved field.
        for (const [_idx, _signal] of includedSignals) {
            const reserved = '' // This can be replaced with something later if needed.
            for (let i = 0; i < 32; i++) {
                headerView.setUint8(offset++, reserved.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
            }
        }
        this.#buffers.header = headerBuffer
        return headerBuffer
    }

    async #writeSignalBuffer (): Promise<ArrayBuffer | null> {
        this.#buffers.signals = null
        if (!this.#header) {
            Log.error(`Cannot write signal buffer, current header property is empty.`, SCOPE)
            return null
        }
        if (!this.#locked) {
            Log.error(`Cannot write signal buffer, header properties are not locked.`, SCOPE)
            return null
        }
        if (!this.#physicalSignals.length) {
            Log.error(`Cannot write signal buffer, no signals are set.`, SCOPE)
            return null
        }
        // Get a list of included signals based on the #signalsToInclude array.
        const includedSignals = this.#includedSignals
        if (!includedSignals.size) {
            Log.error(`Cannot write signal buffer, no signals to include.`, SCOPE)
            return null
        }
        const startTime = Date.now()
        Log.debug(`Writing signal buffer for ${includedSignals.size} signals.`, SCOPE)
        // Check if we should encode timestamps into the EDF+ annotations signal.
        // Since we use a fixed record duration of 1 second, we can only encode gaps with a starting time and duration
        // of full second(s).
        // If the recording does not contain gaps or we cannot encode them, produce a normal EDF file.
        const encodeGaps = this.#header.discontinuous
                           && this.#footer.dataGaps.length
                           && !this.#footer.dataGaps.filter(
                                    ([start, duration]) => start % 1 !== 0 && duration % 1 !== 0
                                ).length
        if (!encodeGaps && this.#header.discontinuous) {
            Log.warn(
                `Recording is discontinuous but either contains no data gaps or contains incompatible gaps ` +
                `(only gaps with a start and duration of full seconds are supported). ` +
                `Producing a normal EDF file instead.`,
                SCOPE
            )
        }
        // See if we have a digital signal to encode and if it can be used.
        if (this.#edfHeader && this.#edfSignalBuffer) {
            if (this.#edfHeader.dataRecordDuration !== 1) {
                Log.error(
                    `Cannot write digital signals, EDF header data record duration is not 1 second. ` +
                    `Current value: ${this.#edfHeader.dataRecordDuration}.`,
                    SCOPE
                )
                return null
            }
        }
        // Calculate the total byte size of the signal data.
        // The annotations signal takes up space equal to the length of the timestamp + 3 bytes (1 for the
        // preceding '+' and two for the trailing 0x20 delimiters) in each data record.
        // Since the number of samples must be the same in each recording, we have to use the maximum timestamp
        // length across all records.
        // We will use a record duration of 1 second by default. Smaller durations would require all of the
        // included signals to have sampling rates with common denominators and is outside the scope of this
        // simple encoder at this point.
        /** The main offset is measured in bytes. */
        let byteOffset = 0
        const annoLength = this.#header.discontinuous
                         ? (this.#header.dataDuration.toFixed().length + 3)
                         : 0
        let recordSize = annoLength
        let totalByteSize = recordSize*this.#header.dataDuration
        for (const [_i, signal] of includedSignals) {
            recordSize += signal.samplingRate*2
            totalByteSize += signal.sampleCount*2
        }
        const signalBuffer = new ArrayBuffer(totalByteSize)
        for (let r=0; r<this.#header.dataDuration; r++) {
            // Use signal view to write individual signal samples in little-endian format.
            const signalView = new DataView(signalBuffer)
            // Write 1 second of data for each signal.
            for (const [i, signal] of includedSignals) {
                if (this.#physicalSignals[i].length < (r + 1)*signal.sampleCount) {
                    Log.error(`Signal data for signal index ${i} is too short for record index ${r}.`, SCOPE)
                    return null
                }
                // If we have a digital signal, we can write it directly.
                if (this.#edfSignalBuffer && this.#edfHeader) {
                    // Calculate offset for the start of this record and the signal part within that record.
                    const offset = this.#edfHeader.signalInfo.slice(0, i).reduce(
                        (acc, sig) => acc + sig.sampleCount*EdfEncoder.SAMPLE_SIZE,
                        r*this.#edfHeader.recordByteSize // Byte size of preceding records.
                    )
                    const signalView = new Int16Array(signalBuffer, offset, signal.samplingRate)
                    if (this.#edfSignalBuffer.length < (r + 1)*signal.samplingRate) {
                        Log.error(`Digital signal data is too short for record index ${r}.`, SCOPE)
                        return null
                    }
                    // Copy the signal data record from the digital signals array.
                    const value = this.#edfSignalBuffer.subarray(
                        r*signal.samplingRate, (r + 1)*signal.samplingRate
                    )
                    signalView.set(value)
                    byteOffset += offset
                    // Rest of the loop is for encoding physical signals into Int16.
                    continue
                } else if (this.#digitalSignals[i]) {
                    // If we have a digital signal, write it directly.
                    if (this.#digitalSignals[i].length < (r + 1)*signal.samplingRate) {
                        Log.error(`Digital signal data is too short for record index ${r}.`, SCOPE)
                        return null
                    }
                    const offset = r*signal.sampleCount*EdfEncoder.SAMPLE_SIZE
                    const signalView = new Int16Array(signalBuffer, offset, signal.samplingRate)
                    // Copy the signal data record from the digital signals array.
                    const value = this.#digitalSignals[i].subarray(
                        r*signal.samplingRate, (r + 1)*signal.samplingRate
                    )
                    signalView.set(value)
                    byteOffset += offset
                    // Rest of the loop is for encoding physical signals into Int16.
                    continue
                }
                // Encode dignals from the Float32Array signal data.
                if (this.#physicalSignals[i].length < (r + 1)*signal.samplingRate) {
                    Log.error(
                        `Physical signal ${i} data is too short for record index ${r} ` +
                        `(expected ≥${(r + 1)*signal.samplingRate}, got ${this.#physicalSignals[i].length}).`, SCOPE)
                    return null
                }
                const signalData = this.#physicalSignals[i].subarray(r*signal.sampleCount, (r + 1)*signal.sampleCount)
                const [physMin, physMax] = this.#getPhysicalRangeFor(i, signal)
                const unitsPerBit = (physMax - physMin)/(EdfEncoder.DIGITAL_MAX - EdfEncoder.DIGITAL_MIN)
                const digitalOffset = physMax/unitsPerBit - EdfEncoder.DIGITAL_MAX
                let offset = 0
                for (let j=0; j<signalData.length; j++) {
                    // Write the signal data as Int16 values.
                    const value = Math.max(
                        EdfEncoder.DIGITAL_MIN,
                        Math.min(
                            EdfEncoder.DIGITAL_MAX,
                            Math.round(signalData[j]/unitsPerBit) - digitalOffset
                        )
                    )
                    signalView.setInt16(offset, value, true)
                    offset++ // Offset is in 16-bit samples.
                }
                byteOffset += offset*EdfEncoder.SAMPLE_SIZE
            }
            // Write the annotations signal data if it is included.
            if (this.#header.discontinuous) {
                // Write the timestamp followed by two delimiters.
                const timestamp = `+${r}`
                for (let i=0; i<annoLength; i++) {
                    signalView.setUint8(
                        byteOffset++,
                        timestamp.charCodeAt(i)
                        // Append with two TAL delimiter codes and the empty spaces after that.
                        || (i < timestamp.length + 2 ? EdfEncoder.TAL_DELIMITER : EdfEncoder.EMPTY_SPACE)
                    )
                }
            }
            if (byteOffset%recordSize) {
                Log.error(
                    `Signal data offset is not aligned at offset ${byteOffset} (` +
                        `got modulus of ${byteOffset%recordSize} with record size ${recordSize} bytes` +
                    `).`,
                    SCOPE
                )
                return null
            }
        }
        Log.debug(
            `Wrote ${this.#header.dataDuration} data records of ${includedSignals.size} signals. ` +
            `Total size: ${signalBuffer.byteLength} bytes. ` +
            `Time taken: ${Date.now() - startTime} ms.`,
            SCOPE
        )
        this.#buffers.signals = signalBuffer
        return signalBuffer
    }

    createHeader (properties?: Partial<EdfHeader>): EdfHeader {
        if (this.#edfHeader) {
            Log.error(
                `Cannot create header, current header property is not empty.` +
                `Use the 'updateHeader' method to change header attributes.`,
                SCOPE
            )
            return this.#edfHeader
        }
        this.#edfHeader = safeObjectFrom({
            dataFormat: 'edf',
            /** Number of data records in the recording. */
            dataRecordCount: 0,
            /** Duration of each data record in seconds. */
            dataRecordDuration: 0,
            /** Is the source signal discontinous. */
            discontinuous: false,
            /** How many bytes are occupied by the header record at the beginning of the file. */
            headerRecordBytes: 0,
            isPlus: false,
            localRecordingId: 'Epicurrents EDF',
            patientId: 'Anonymous',
            /** Number of bytes per data record. */
            recordByteSize: 0,
            recordingDate: null,
            reserved: '',
            /** Number of signals in the file. */
            signalCount: 0,
            /** EDF-specific signal information parsed from the header record. */
            signalInfo: [],
        })
        this.#updateEdfHeader(properties)
        return this.#edfHeader!
    }

    setAnnotations (annotations: AnnotationTemplate[]) {
        if (this.#locked) {
            Log.error(`Cannot set annotations, header properties are locked.`, SCOPE)
            return
        }
        this.#footer.annotations = annotations
    }

    setDataGaps (dataGaps: [number, number][]) {
        if (this.#locked) {
            Log.error(`Cannot set data gaps, header properties are locked.`, SCOPE)
            return
        }
        this.#footer.dataGaps = dataGaps
    }

    setEdfSignalBuffer (signalBuffer: Int16Array) {
        if (this.#locked) {
            Log.error(`Cannot set digital signals, header properties are locked.`, SCOPE)
            return
        }
        this.#edfSignalBuffer = signalBuffer
    }

    setEdfHeader (header: EdfHeader) {
        if (this.#locked) {
            Log.error(`Cannot set EDF header, header properties are locked.`, SCOPE)
            return
        }
        this.#updateEdfHeader(header)
    }

    setFooter (footer: Partial<EdfFooter>) {
        if (this.#locked) {
            Log.error(`Cannot set footer, header properties are locked.`, SCOPE)
            return
        }
        // Update the footer properties with the given properties.
        this.#updateFooter(footer)
    }

    setSignalsToInclude (signals: number[]) {
        if (this.#locked) {
            Log.error(`Cannot set included signals, header properties are locked.`, SCOPE)
            return
        }
        this.#signalsToInclude = [...signals]
    }

    setSignals (signals: Float32Array[]) {
        if (this.#locked) {
            Log.error(`Cannot set signals, header properties are locked.`, SCOPE)
            return
        }
        this.#physicalSignals = [...signals]
    }

    updateEdfHeader (properties: Partial<EdfHeader>) {
        if (!this.#edfHeader) {
            Log.debug(`updateHeader called without a pre-existing header, creating a new one.`, SCOPE)
            this.createHeader(properties)
            return
        }
        if (this.#locked) {
            Log.error(`Cannot update EDF header, header properties are locked.`, SCOPE)
            return
        }
        this.#updateEdfHeader(properties)
    }

    async writeToArrayBuffer (anonymize = false): Promise<ArrayBuffer | null> {
        if (!this.#header) {
            Log.error(`Cannot write to ArrayBuffer, current header property is empty.`, SCOPE)
            return null
        }
        this.#locked = true // Lock the header properties to prevent further changes.
        const footerBuffer = await this.#writeFooterBuffer(anonymize)
        if (!footerBuffer) {
            Log.error(`Failed to write footer buffer.`, SCOPE)
            return null
        }
        Log.debug(`Footer buffer written, size: ${footerBuffer.byteLength} bytes.`, SCOPE)
        const headerBuffer = await this.#writeHeaderBuffer(anonymize)
        if (!headerBuffer) {
            Log.error(`Failed to write header buffer.`, SCOPE)
            return null
        }
        Log.debug(`Header buffer written, size: ${headerBuffer.byteLength} bytes.`, SCOPE)
        const signalBuffer = await this.#writeSignalBuffer()
        if (!signalBuffer) {
            Log.error(`Failed to write signal buffer.`, SCOPE)
            return null
        }
        Log.debug(`Signal buffer written, size: ${signalBuffer.byteLength} bytes.`, SCOPE)
        // Combine all buffers into a single ArrayBuffer.
        const totalSize = headerBuffer.byteLength + signalBuffer.byteLength + footerBuffer.byteLength
        const combinedBuffer = new ArrayBuffer(totalSize)
        const combinedView = new Uint8Array(combinedBuffer)
        combinedView.set(new Uint8Array(headerBuffer), 0)
        combinedView.set(new Uint8Array(signalBuffer), headerBuffer.byteLength)
        combinedView.set(new Uint8Array(footerBuffer), headerBuffer.byteLength + signalBuffer.byteLength)
        Log.debug(`Combined EDF buffer written, total size: ${combinedBuffer.byteLength} bytes.`, SCOPE)
        this.#locked = false // Unlock the header properties after writing.
        return combinedBuffer
    }
}
