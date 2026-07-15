/**
 * Epicurrents EDF encoder. This class can be used to encode signal data into a custom EDF format.
 * @package    epicurrents/edf-reader
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import { headerToBiosignalHeader } from '#util'
import type {
    EdfEncodeOptions,
    EdfFooter,
    EdfHeader,
    EdfRecordingType,
    EdfSidecar,
} from '#types'
import type {
    AnnotationTemplate,
    BiosignalHeaderRecord,
    BiosignalHeaderSignal,
    SignalDataEncoder,
    SignalInterruptionMap,
} from '@epicurrents/core/dist/types'
import { safeObjectFrom } from '@epicurrents/core/dist/util'
import { Log } from 'scoped-event-log'
import { GenericAsset, GenericBiosignalHeader } from '@epicurrents/core'

const SCOPE = 'EdfEncoder'
/** Schema version written into the sidecar and embedded footer. */
const SIDECAR_VERSION = '1.0'

export default class EdfEncoder extends GenericAsset implements SignalDataEncoder {
    /** Free-form annotations. Deliberately excluded from the sidecar; retained only for possible future use. */
    #annotations: AnnotationTemplate[] = []
    /** Buffers that are ready to be written into the EDF file. */
    #buffers = {
        footer: null as ArrayBuffer | null,
        header: null as ArrayBuffer | null,
        signals: null as ArrayBuffer | null,
    }
    #dataEncoding: TypedNumberArrayConstructor
    #digitalSignals: Int16Array[] = []
    #edfHeader: EdfHeader | null = null
    /** Digital signal buffer from a source EDF recording. */
    #edfSignalBuffer: Int16Array | null = null
    #footer = safeObjectFrom({
        attachments: [],
        channels: [],
        config: {},
        events: [],
        interruptions: new Map(),
        labels: [],
        modality: 'eeg',
        recordingDate: null,
        version: SIDECAR_VERSION,
        videoCount: 0,
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
    constructor (recordingType: EdfRecordingType, dataEncoding: TypedNumberArrayConstructor = Int16Array) {
        super('edf-encoder', 'writer')
        this.#dataEncoding = dataEncoding
        this.#recordingType = recordingType
        this.#footer.modality = recordingType
    }

    get annotations () {
        return this.#annotations
    }

    get dataEncoding () {
        return this.#dataEncoding
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
            this.#footer.events = this.#header.events || []
            this.#footer.labels = this.#header.labels || []
            this.#footer.interruptions = this.#header.interruptions || new Map()
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

    #updateHeader (properties?: Partial<BiosignalHeaderRecord>) {
        if (this.#locked) {
            Log.error(`Cannot update header, header properties are locked.`, SCOPE)
            return
        }
        if (properties?.dataUnitDuration !== undefined && properties.dataUnitDuration !== 1) {
            // Warn user if the data unit duration is not 1 second.
            Log.warn(
                `EdfEncoder only supports 1 second data unit duration, ` +
                `trying to encode signal data with new value of ${properties.dataUnitDuration} will fail.`,
                SCOPE
            )
        }
        // GenericBiosignalHeader exposes read-only accessors (apart from its adders), so merge the current values
        // with the given properties and construct a fresh header rather than mutating in place.
        const current = this.#header
        this.#header = new GenericBiosignalHeader(
            'edf',
            properties?.recordingId ?? current?.recordingId ?? 'Epicurrents EDF',
            properties?.patientId ?? current?.patientId ?? 'Anonymous',
            properties?.dataUnitCount ?? current?.dataUnitCount ?? 0,
            properties?.dataUnitDuration ?? current?.dataUnitDuration ?? 1,
            properties?.dataUnitSize ?? current?.dataUnitSize ?? 0,
            properties?.signalCount ?? current?.signalCount ?? 0,
            properties?.signals ?? current?.signals ?? [],
            properties?.recordingStartTime ?? current?.recordingStartTime ?? null,
            properties?.discontinuous ?? current?.discontinuous ?? false,
            properties?.events ?? current?.events ?? [],
            properties?.labels ?? current?.labels ?? [],
            properties?.interruptions ?? current?.interruptions ?? new Map(),
        )
        // Update the footer based on the header.
        this.#updateFooter()
    }

    /**
     * Build the serializable sidecar metadata object from the current header and footer state.
     * @param anonymize - Blank subject identifiers and strip event/label text (structured events/labels are kept).
     */
    #buildSidecarObject (anonymize: boolean): EdfSidecar {
        const events = this.#footer.events || []
        const labels = this.#footer.labels || []
        return {
            channels: this.#footer.channels,
            events: anonymize ? this.#stripAnnotationText(events) : events,
            interruptions: this.#serializeInterruptions(this.#footer.interruptions),
            labels: anonymize ? this.#stripAnnotationText(labels) : labels,
            modality: this.#recordingType,
            subject: anonymize
                ? { patientId: null, recordingDate: null, recordingId: null }
                : {
                    patientId: this.#header?.patientId ?? null,
                    recordingDate: this.#footer.recordingDate,
                    recordingId: this.#header?.recordingId ?? null,
                },
            version: SIDECAR_VERSION,
        }
    }

    /** Convert the interruption map into a JSON-serializable array of `[start, duration]` pairs. */
    #serializeInterruptions (interruptions: SignalInterruptionMap): [number, number][] {
        return Array.from(interruptions.entries(), ([start, duration]): [number, number] => [start, duration])
    }

    /** Remove the free-text and author fields from events or labels, preserving their structural properties. */
    #stripAnnotationText<T extends AnnotationTemplate> (items: T[]): T[] {
        return items.map(item => ({ ...item, annotator: undefined, text: '' }))
    }

    async #writeFooterBuffer (anonymize = false): Promise<ArrayBuffer | null> {
        this.#buffers.footer = null
        if (!this.#locked) {
            Log.error(`Cannot write footer buffer, header properties are not locked.`, SCOPE)
            return null
        }
        // Create a JSON string from the sidecar object and convert to an UTF-8 byte array.
        const footerBytes = new TextEncoder().encode(JSON.stringify(this.#buildSidecarObject(anonymize)))
        // Calculate the size of the footer in KB.
        const footerSize = Math.ceil(footerBytes.length / 1024)
        // Create an ArrayBuffer for the footer, padded to a full KB.
        const footerBuffer = new ArrayBuffer(footerSize * 1024)
        const footerView = new Uint8Array(footerBuffer)
        footerView.set(footerBytes)
        this.#buffers.footer = footerBuffer
        return footerBuffer
    }

    async #writeHeaderBuffer (anonymize = false, embedFooter = false): Promise<ArrayBuffer | null> {
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
        // Write the local patient ID; blank it for anonymized output.
        const patientId = anonymize ? 'X X X X' : (this.#header.patientId || 'Anonymous')
        for (let i = 0; i < 80; i++) {
            headerView.setUint8(offset++, patientId.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
        }
        // Write the local recording ID; blank it for anonymized output.
        const recordingId = anonymize ? 'Startdate X X X X' : (this.#header.recordingId || 'Epicurrents EDF')
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
        // Write the number of bytes occupied by the header record.
        const headerRecordBytes = headerBytes.toString()
        for (let i = 0; i < 8; i++) {
            headerView.setUint8(offset++, headerRecordBytes.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
        }
        // Write the reserved field. When embedding the sidecar as a footer, use the Epicurrents container marker
        // `<EDF|EDF+D> EC:<total bytes>:<footer KB>`; otherwise emit a standard EDF/EDF+ reserved field so the file
        // reads as ordinary EDF in third-party tools.
        let reserved = this.#header.discontinuous ? 'EDF+D' : ''
        if (embedFooter) {
            // Compute the byte size of the entire recording.
            const totalByteSize = headerBytes + this.#header.dataUnitCount*this.#header.dataUnitSize
            // Get the footer size in KB.
            const footerBuffer = this.#buffers.footer || (await this.#writeFooterBuffer())
            if (!footerBuffer) {
                Log.error(`Failed to write footer buffer for size estimation.`, SCOPE)
                return null
            }
            const footerSize = Math.ceil(footerBuffer.byteLength/1024)
            reserved = this.#header.discontinuous
                     ? `EDF+D EC:${totalByteSize}:${footerSize}`
                     : `EDF EC:${totalByteSize}:${footerSize}`
        }
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
        // Write the label for each signal. Channel labels are technical metadata (electrode names, e.g. "EEG C3"),
        // not subject-identifying information, and montages match on them, so they are preserved even when anonymizing.
        for (const [_idx, signal] of includedSignals) {
            for (let i = 0; i < 16; i++) {
                headerView.setUint8(offset++, signal.label.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
            }
        }
        // Write the transducer names. Like labels, transducer types are technical metadata and are preserved.
        for (const [_idx, signal] of includedSignals) {
            for (let i = 0; i < 80; i++) {
                headerView.setUint8(offset++, signal.sensor.charCodeAt(i) || EdfEncoder.EMPTY_SPACE)
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
            const physMax = this.#getPhysicalRangeFor(idx, signal)[1]
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
        // Write the number of samples per data record. With a fixed 1 second record duration this equals the
        // signal's sampling rate, not its total sample count.
        for (const [_idx, signal] of includedSignals) {
            const samplesPerRecord = (signal.samplingRate || 0).toString()
            for (let i = 0; i < 8; i++) {
                headerView.setUint8(offset++, (samplesPerRecord.charCodeAt(i) || EdfEncoder.EMPTY_SPACE))
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
        // Included signals in header order, paired with their per-record sample count (the sampling rate, since a
        // data record is a fixed one second long). Smaller record durations would require all included signals to
        // have sampling rates with a common denominator and are outside the scope of this encoder.
        const included = Array.from(includedSignals)
        const samplesPerRecord = included.map(([_i, signal]) => signal.samplingRate || 0)
        // Number of one-second data records to write.
        const recordCount = this.#header.dataUnitCount || Math.round(this.#header.dataDuration) || 0
        Log.debug(`Writing signal buffer for ${included.length} signals over ${recordCount} records.`, SCOPE)
        // Discontinuous (EDF+D) output requires an annotation signal declared in the header, which is not yet
        // written, so fall back to a continuous file for now.
        if (this.#header.discontinuous) {
            Log.warn(
                `Discontinuous (EDF+D) encoding is not yet supported; producing a continuous EDF file instead.`,
                SCOPE
            )
        }
        // The contiguous source-EDF buffer passthrough is not yet wired into this path; per-channel digital signals
        // and physical signals are supported instead.
        if (this.#edfSignalBuffer) {
            Log.warn(`Contiguous digital source buffer passthrough is not yet supported; it will be ignored.`, SCOPE)
        }
        // Byte size of one data record: each signal's samples-per-record times the sample size.
        const recordByteSize = samplesPerRecord.reduce((acc, spr) => acc + spr*EdfEncoder.SAMPLE_SIZE, 0)
        const signalBuffer = new ArrayBuffer(recordByteSize*recordCount)
        const signalView = new DataView(signalBuffer)
        for (let r = 0; r < recordCount; r++) {
            // Byte offset of the current signal within the buffer, advanced per signal within the record.
            let byteOffset = r*recordByteSize
            for (let c = 0; c < included.length; c++) {
                const [i, signal] = included[c]
                const spr = samplesPerRecord[c]
                if (this.#digitalSignals[i]) {
                    // Copy digital Int16 samples directly.
                    const digital = this.#digitalSignals[i]
                    if (digital.length < (r + 1)*spr) {
                        Log.error(`Digital signal ${i} data is too short for record ${r}.`, SCOPE)
                        return null
                    }
                    for (let j = 0; j < spr; j++) {
                        signalView.setInt16(byteOffset + j*EdfEncoder.SAMPLE_SIZE, digital[r*spr + j], true)
                    }
                } else {
                    // Quantize physical Float32 samples into Int16 using the signal's physical range.
                    const physical = this.#physicalSignals[i]
                    if (!physical || physical.length < (r + 1)*spr) {
                        Log.error(
                            `Physical signal ${i} data is too short for record ${r} ` +
                            `(expected ≥${(r + 1)*spr}, got ${physical?.length ?? 0}).`,
                            SCOPE
                        )
                        return null
                    }
                    const [physMin, physMax] = this.#getPhysicalRangeFor(i, signal)
                    // Physical units represented by a single digital step; guard against a zero-width (flat) range.
                    const unitsPerBit = physMax > physMin
                                      ? (physMax - physMin)/(EdfEncoder.DIGITAL_MAX - EdfEncoder.DIGITAL_MIN)
                                      : 1
                    for (let j = 0; j < spr; j++) {
                        const digital = Math.round((physical[r*spr + j] - physMin)/unitsPerBit) + EdfEncoder.DIGITAL_MIN
                        const clamped = Math.max(EdfEncoder.DIGITAL_MIN, Math.min(EdfEncoder.DIGITAL_MAX, digital))
                        signalView.setInt16(byteOffset + j*EdfEncoder.SAMPLE_SIZE, clamped, true)
                    }
                }
                byteOffset += spr*EdfEncoder.SAMPLE_SIZE
            }
        }
        Log.debug(
            `Wrote ${recordCount} data records of ${included.length} signals. ` +
            `Total size: ${signalBuffer.byteLength} bytes. Time taken: ${Date.now() - startTime} ms.`,
            SCOPE
        )
        this.#buffers.signals = signalBuffer
        return signalBuffer
    }

    /**
     * Build the sidecar metadata as a JSON string. This is the primary metadata artifact for anonymized exports; it
     * carries the original (or, when anonymized, blanked) subject information, signal descriptions, events, and labels.
     * @param options - Set `anonymize` to blank subject identifiers and strip event/label text.
     * @returns The sidecar as a JSON string.
     */
    buildSidecar (options: { anonymize?: boolean } = {}): string {
        return JSON.stringify(this.#buildSidecarObject(options.anonymize ?? false))
    }

    createHeader (properties?: Partial<BiosignalHeaderRecord>) {
        if (this.#locked) {
            Log.error(`Cannot create header, header properties are locked.`, SCOPE)
            return this.#edfHeader || safeObjectFrom({})
        }
        if (this.#header) {
            Log.error(
                `Cannot create header, current header property is not empty.` +
                `Use the 'setHeader' method to change header attributes.`,
                SCOPE
            )
            return this.#header
        }
        // Construct the header from the ground up out of the given properties (merged over the defaults).
        this.#updateHeader(properties)
        return this.#header!
    }

    createHeaderFromEdf (properties?: Partial<EdfHeader>): EdfHeader {
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
            /** Is the source signal discontinuous. */
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
        }) as EdfHeader
        this.#updateEdfHeader(properties)
        return this.#edfHeader!
    }

    async encode (anonymize = false, options: EdfEncodeOptions = {}): Promise<ArrayBuffer | null> {
        if (!this.#header) {
            Log.error(`Cannot write to ArrayBuffer, current header property is empty.`, SCOPE)
            return null
        }
        const embedFooter = options.embedFooter ?? false
        const embedFooterAnonymized = options.embedFooterAnonymized ?? anonymize
        this.#locked = true // Lock the header properties to prevent further changes.
        // Only build the embedded footer when explicitly requested; the primary export path delivers the sidecar as a
        // separate file via `buildSidecar`.
        let footerBuffer: ArrayBuffer | null = null
        if (embedFooter) {
            footerBuffer = await this.#writeFooterBuffer(embedFooterAnonymized)
            if (!footerBuffer) {
                Log.error(`Failed to write footer buffer.`, SCOPE)
                this.#locked = false
                return null
            }
            Log.debug(`Footer buffer written, size: ${footerBuffer.byteLength} bytes.`, SCOPE)
        }
        const headerBuffer = await this.#writeHeaderBuffer(anonymize, embedFooter)
        if (!headerBuffer) {
            Log.error(`Failed to write header buffer.`, SCOPE)
            this.#locked = false
            return null
        }
        Log.debug(`Header buffer written, size: ${headerBuffer.byteLength} bytes.`, SCOPE)
        const signalBuffer = await this.#writeSignalBuffer()
        if (!signalBuffer) {
            Log.error(`Failed to write signal buffer.`, SCOPE)
            this.#locked = false
            return null
        }
        Log.debug(`Signal buffer written, size: ${signalBuffer.byteLength} bytes.`, SCOPE)
        // Combine the buffers into a single ArrayBuffer (footer only when embedded).
        const totalSize = headerBuffer.byteLength + signalBuffer.byteLength + (footerBuffer?.byteLength || 0)
        const combinedBuffer = new ArrayBuffer(totalSize)
        const combinedView = new Uint8Array(combinedBuffer)
        combinedView.set(new Uint8Array(headerBuffer), 0)
        combinedView.set(new Uint8Array(signalBuffer), headerBuffer.byteLength)
        if (footerBuffer) {
            combinedView.set(new Uint8Array(footerBuffer), headerBuffer.byteLength + signalBuffer.byteLength)
        }
        Log.debug(`Combined EDF buffer written, total size: ${combinedBuffer.byteLength} bytes.`, SCOPE)
        this.#locked = false // Unlock the header properties after writing.
        return combinedBuffer
    }

    setAnnotations (annotations: AnnotationTemplate[]) {
        if (this.#locked) {
            Log.error(`Cannot set annotations, header properties are locked.`, SCOPE)
            return
        }
        this.#annotations = annotations
    }

    setInterruptions (interruptions: SignalInterruptionMap) {
        if (this.#locked) {
            Log.error(`Cannot set interruptions, header properties are locked.`, SCOPE)
            return
        }
        this.#footer.interruptions = interruptions
    }

    setEdfSignals (signals: Int16Array[]) {
        if (this.#locked) {
            Log.error(`Cannot set digital signals, header properties are locked.`, SCOPE)
            return
        }
        this.#digitalSignals = [...signals]
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
        if (!this.#edfHeader) {
            Log.debug(`updateHeader called without a pre-existing header, creating a new one.`, SCOPE)
            this.createHeaderFromEdf(header)
            return
        }
        this.#updateEdfHeader(header)
    }

    setHeader (properties?: Partial<BiosignalHeaderRecord>) {
        if (this.#locked) {
            Log.error(`Cannot set header, header properties are locked.`, SCOPE)
            return this.#header || safeObjectFrom({})
        }
        if (this.#header) {
            Log.error(
                `Cannot set header, current header property is not empty.` +
                `Use the 'updateHeader' method to change header attributes.`,
                SCOPE
            )
            return this.#header
        }
        // Create a new header object with default values.
        this.createHeader(properties)
        return this.#header!
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
        if (this.#locked) {
            Log.error(`Cannot update EDF header, header properties are locked.`, SCOPE)
            return
        }
        this.#updateEdfHeader(properties)
    }
}
