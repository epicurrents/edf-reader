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
    EdfFooterChannel,
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
} from '@epicurrents/core/types'
import { safeObjectFrom } from '@epicurrents/core/util'
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
    /** The most 32-bit words one `crypto.getRandomValues` call fills; it refuses a request over 65536 bytes. */
    static readonly RANDOM_WORDS_PER_CALL = 16384
    /** Byte width of one encoded sample; an `Int16` is two bytes. */
    static readonly SAMPLE_SIZE = 2
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
     * Fill `count` 32-bit words from the platform's cryptographic source, in as many calls as its per-call limit needs.
     * @param count - Number of words to fill.
     */
    static randomWords (count: number): Uint32Array {
        const words = new Uint32Array(count)
        for (let start = 0; start < count; start += EdfEncoder.RANDOM_WORDS_PER_CALL) {
            crypto.getRandomValues(words.subarray(start, Math.min(count, start + EdfEncoder.RANDOM_WORDS_PER_CALL)))
        }
        return words
    }

    /**
     * Write `text` into a fixed-width header field, space-padded and truncated to `width`.
     *
     * A character outside printable ASCII is written as a space. The format's fields are ASCII, and `setUint8` stores
     * the low byte of a code point, so a `µ` or an accented name would otherwise be written as an unrelated byte.
     * @param view - View over the header buffer.
     * @param offset - Byte offset the field starts at.
     * @param width - Width of the field in bytes.
     * @param text - Text to write.
     * @returns The byte offset just past the field.
     */
    static writeAsciiField (view: DataView, offset: number, width: number, text: string): number {
        for (let i = 0; i < width; i++) {
            const code = text.charCodeAt(i)
            view.setUint8(offset + i, code >= 32 && code <= 126 ? code : EdfEncoder.EMPTY_SPACE)
        }
        return offset + width
    }

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

    /**
     * Render a number into the eight ASCII characters an EDF numeric header field holds.
     *
     * The plain decimal is used whenever it fits. Otherwise it is rounded to as many decimal places as fit, and a
     * magnitude below what eight characters of plain decimal can express at all falls back to exponent notation
     * rather than to zero: a value the field cannot hold is the one case where the format's readers are asked for
     * `strtod` rather than for digits, and writing `0.000000` instead would flatten the channel.
     *
     * Truncating the string is what this replaces. `(-1.2345e-7).toString()` is ten characters, and its first eight
     * are `-1.2345e`, which parses back as `1.2345` — the sign gone and the magnitude out by seven orders.
     */
    #numericField (value: number): string {
        const plain = `${value}`
        if (plain.length <= 8 && !plain.includes('e')) {
            return plain
        }
        if (!Number.isFinite(value)) {
            Log.error(`Cannot write ${plain} into an EDF header field; writing 0 instead.`, SCOPE)
            return '0'
        }
        for (let decimals = 6; decimals >= 0; decimals--) {
            const fixed = value.toFixed(decimals)
            if (fixed.length <= 8 && parseFloat(fixed) !== 0) {
                return fixed
            }
        }
        for (let decimals = 3; decimals >= 0; decimals--) {
            const exponential = value.toExponential(decimals)
            if (exponential.length <= 8) {
                Log.warn(
                    `Value ${plain} does not fit an EDF header field as a decimal; writing ${exponential}.`,
                SCOPE)
                return exponential
            }
        }
        Log.error(`Cannot write ${plain} into an EDF header field; writing 0 instead.`, SCOPE)
        return '0'
    }

    /** A header with nothing in it, to return where a caller asked for one that cannot be built. */
    #emptyHeader (): BiosignalHeaderRecord {
        return new GenericBiosignalHeader('edf', '', '', 0, 1, 0, 0, [])
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
            // A record is one second long, so its samples per signal are the signal's sampling rate.
            (acc, signal) => acc + (signal.sampleCount/this.#edfHeader!.dataRecordDuration)*EdfEncoder.SAMPLE_SIZE,
            0
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
                samplesPerRecord: signal.samplingRate || 0,
                samplingRate: signal.samplingRate || 0,
                scale: 0,
                sensitivity: signal.sensitivity || 0,
                unit: signal.physicalUnit || '',
            }) as EdfFooterChannel)
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
            properties?.patientId ?? current?.patientId ?? 'X X X X',
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
     * @param deidentify - Blank subject identifiers and strip event/label text (structured events/labels are kept).
     */
    #buildSidecarObject (deidentify: boolean): EdfSidecar {
        const events = this.#footer.events || []
        const labels = this.#footer.labels || []
        return {
            channels: this.#footer.channels,
            events: deidentify ? this.#stripAnnotationText(events) : events,
            interruptions: this.#serializeInterruptions(this.#footer.interruptions),
            labels: deidentify ? this.#stripAnnotationText(labels) : labels,
            modality: this.#recordingType,
            subject: deidentify
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

    /**
     * Serialize the sidecar object, leaving out every property named in `removeKeys` at any depth. Array indices are
     * never matched, so a key that happens to be numeric removes object properties only.
     */
    #serializeSidecar (deidentify: boolean, removeKeys: string[]): string {
        const sidecar = this.#buildSidecarObject(deidentify)
        if (!removeKeys.length) {
            return JSON.stringify(sidecar)
        }
        const remove = new Set(removeKeys)
        return JSON.stringify(sidecar, function (this: unknown, key: string, value: unknown) {
            return key && !Array.isArray(this) && remove.has(key) ? undefined : value
        })
    }

    /** Remove the free-text and author fields from events or labels, preserving their structural properties. */
    #stripAnnotationText<T extends AnnotationTemplate> (items: T[]): T[] {
        return items.map(item => ({ ...item, annotator: undefined, text: '' }))
    }

    #writeFooterBuffer (deidentify = false, removeKeys: string[] = []): ArrayBuffer | null {
        this.#buffers.footer = null
        if (!this.#locked) {
            Log.error(`Cannot write footer buffer, header properties are not locked.`, SCOPE)
            return null
        }
        // Create a JSON string from the sidecar object and convert to an UTF-8 byte array.
        const footerBytes = new TextEncoder().encode(this.#serializeSidecar(deidentify, removeKeys))
        // Calculate the size of the footer in KB.
        const footerSize = Math.ceil(footerBytes.length / 1024)
        // Create an ArrayBuffer for the footer, padded to a full KB.
        const footerBuffer = new ArrayBuffer(footerSize * 1024)
        const footerView = new Uint8Array(footerBuffer)
        footerView.set(footerBytes)
        this.#buffers.footer = footerBuffer
        return footerBuffer
    }

    /**
     * Write the header record. With `embedFooter`, `dataBytes` is the byte size of the data records as written, which
     * the container marker names together with the header size so a reader can find the footer.
     */
    #writeHeaderBuffer (deidentify = false, embedFooter = false, dataBytes = 0): ArrayBuffer | null {
        this.#buffers.header = null
        if (!this.#header) {
            Log.error(`Cannot write header buffer, current header property is empty.`, SCOPE)
            return null
        }
        if (!this.#locked) {
            Log.error(`Cannot write header buffer, header properties are not locked.`, SCOPE)
            return null
        }
        const includedSignals = this.#includedSignals // Only generate the map once.
        if (!includedSignals.size) {
            Log.error(`Cannot write header buffer, no signals to include.`, SCOPE)
            return null
        }
        // The header declares the signals it actually carries a block for. `#includedSignals` drops
        // the annotation channel on top of whatever `setSignalsToInclude` named, so counting the
        // header's own signals instead declared one signal more than the file held, leaving a
        // reader to parse the first data record as though it had a channel that is not there.
        const signalCount = includedSignals.size
        const headerBytes = 256 + signalCount*256
        const headerBuffer = new ArrayBuffer(headerBytes)
        const headerView = new DataView(headerBuffer)
        // Write the header data into the buffer.
        let offset = 0
        const writeField = (text: string, width: number) => {
            offset = EdfEncoder.writeAsciiField(headerView, offset, width, text)
        }
        const writeFieldPerSignal = (width: number, text: (signal: BiosignalHeaderSignal, index: number) => string) => {
            for (const [index, signal] of includedSignals) {
                writeField(text(signal, index), width)
            }
        }
        // Write the EDF version.
        writeField('0', 8)
        // Write the local patient ID; blank it for de-identified output.
        // An unknown patient identification is written as the EDF+ unknown-subfield convention, the same as a
        // de-identified one, since there is nothing to blank.
        writeField(deidentify || !this.#header.patientId ? 'X X X X' : this.#header.patientId, 80)
        // Write the local recording ID; blank it for de-identified output.
        writeField(deidentify ? 'Startdate X X X X' : (this.#header.recordingId || 'Epicurrents EDF'), 80)
        // Write the recording date and time, `dd.mm.yy` then `hh.mm.ss`, as two eight-character fields written
        // together. The format states them in the recording's own local time, which is also how the decoder reads
        // them back. A de-identified file carries 01.01.85 00.00.00, the EDF+ placeholder for an unknown start and
        // what the platform's own de-identifier writes, so a file prepared here passes a check for exactly those
        // bytes.
        const start = this.#header.recordingStartTime
        const pad = (value: number) => `${value}`.padStart(2, '0')
        // The year is two digits over the 1985–2084 window the format spans. The EDF+ convention for a start outside
        // it is the literal `yy`, with the real date left to the recording identification field.
        const year = start && start.getFullYear() >= 1985 && start.getFullYear() <= 2084
                     ? pad(start.getFullYear()%100)
                     : 'yy'
        const recordingDateTime = start && !deidentify
                                ? `${pad(start.getDate())}.${pad(start.getMonth() + 1)}.${year}` +
                                  `${pad(start.getHours())}.${pad(start.getMinutes())}.${pad(start.getSeconds())}`
                                : '01.01.8500.00.00'
        writeField(recordingDateTime, 16)
        // Write the number of bytes occupied by the header record.
        writeField(`${headerBytes}`, 8)
        // Write the reserved field. When embedding the sidecar as a footer, use the Epicurrents container marker
        // `EDF EC:<total bytes>:<footer KB>`; otherwise emit a standard EDF/EDF+ reserved field so the file reads
        // as ordinary EDF in third-party tools. A container is plain EDF whatever the recording's continuity: the
        // file has no annotation channel to carry a timeline, and the footer carries the interruptions instead.
        let reserved = this.#header.discontinuous ? 'EDF+D' : ''
        if (embedFooter) {
            // The byte size of the recording proper: the header record and the data records as written. Taken from
            // the written signal buffer rather than the header's data unit size, which a header built from a
            // resource never carries.
            const totalByteSize = headerBytes + dataBytes
            // The footer the marker measures is the one `encode` has already written, with the
            // de-identification and the removed keys it was asked for. Writing one here instead
            // would take the defaults of those arguments and embed unredacted metadata.
            const footerBuffer = this.#buffers.footer
            if (!footerBuffer) {
                Log.error(`Cannot mark the container: the footer has not been written.`, SCOPE)
                return null
            }
            const footerSize = Math.ceil(footerBuffer.byteLength/1024)
            reserved = `EDF EC:${totalByteSize}:${footerSize}`
        }
        writeField(reserved, 44)
        // Write the number of data records.
        writeField(`${this.#header.dataUnitCount || 0}`, 8)
        // Write the duration of each data record in seconds.
        writeField(`${this.#header.dataUnitDuration || 0}`, 8)
        // Write the number of signals.
        writeField(`${signalCount}`, 4)
        // Write the label for each signal. Channel labels are technical metadata (electrode names, e.g. "EEG C3"),
        // not subject-identifying information, and montages match on them, so they are preserved even when
        // de-identifying.
        writeFieldPerSignal(16, signal => signal.label)
        // Write the transducer names. Like labels, transducer types are technical metadata and are preserved.
        writeFieldPerSignal(80, signal => signal.sensor)
        // Write the physical units.
        writeFieldPerSignal(8, signal => signal.physicalUnit)
        // Write the physical minimum and maximum values.
        writeFieldPerSignal(8, (signal, index) => this.#numericField(this.#getPhysicalRangeFor(index, signal)[0]))
        writeFieldPerSignal(8, (signal, index) => this.#numericField(this.#getPhysicalRangeFor(index, signal)[1]))
        // Write the digital minimum and maximum values.
        writeFieldPerSignal(8, () => `${EdfEncoder.DIGITAL_MIN}`)
        writeFieldPerSignal(8, () => `${EdfEncoder.DIGITAL_MAX}`)
        // Write prefiltering information.
        writeFieldPerSignal(80, signal => {
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
            return prefiltering.join(' ')
        })
        // Write the number of samples per data record. With a fixed 1 second record duration this equals the
        // signal's sampling rate, not its total sample count.
        writeFieldPerSignal(8, signal => `${signal.samplingRate || 0}`)
        // Write the per-signal reserved field, which this encoder has nothing to put in.
        writeFieldPerSignal(32, () => '')
        this.#buffers.header = headerBuffer
        return headerBuffer
    }

    /**
     * Write the data records. With `dither`, each physical sample is offset by uniform noise of up to half a digital
     * step before rounding, drawn from the platform's cryptographic source, so encoding the same signal twice gives
     * different bytes. A sample then lands on one of the two digital values around it rather than always the nearer,
     * an error of under one step. Digital signals are copied as given and never dithered.
     */
    #writeSignalBuffer (dither = false): ArrayBuffer | null {
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
                    const noise = dither ? EdfEncoder.randomWords(spr) : null
                    for (let j = 0; j < spr; j++) {
                        // Uniform in [-0.5, 0.5) of one step.
                        const offset = noise ? noise[j]/0x100000000 - 0.5 : 0
                        const digital = Math.round((physical[r*spr + j] - physMin)/unitsPerBit + offset)
                                      + EdfEncoder.DIGITAL_MIN
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
     * Build the sidecar metadata as a JSON string. This is the primary metadata artifact for de-identified exports;
     * it carries the original (or, when de-identified, blanked) subject information, signal descriptions, events and
     * labels.
     * @param options - `deidentify` blanks the subject and strips text; `removeMetadataKeys` names keys to leave out.
     * @returns The sidecar as a JSON string.
     */
    buildSidecar (options: { deidentify?: boolean, removeMetadataKeys?: string[] } = {}): string {
        return this.#serializeSidecar(options.deidentify ?? false, options.removeMetadataKeys ?? [])
    }

    createHeader (properties?: Partial<BiosignalHeaderRecord>): BiosignalHeaderRecord {
        if (this.#locked) {
            Log.error(`Cannot create header, header properties are locked.`, SCOPE)
            return this.#header ?? this.#emptyHeader()
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
            patientId: 'X X X X',
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
        return this.#edfHeader
    }

    encode (deidentify = false, options: EdfEncodeOptions = {}): Promise<ArrayBuffer | null> {
        if (!this.#header) {
            Log.error(`Cannot write to ArrayBuffer, current header property is empty.`, SCOPE)
            return Promise.resolve(null)
        }
        const embedFooter = options.embedFooter ?? false
        const embedFooterDeidentified = options.embedFooterDeidentified ?? deidentify
        this.#locked = true // Lock the header properties to prevent further changes.
        // Only build the embedded footer when explicitly requested; the primary export path delivers the sidecar as a
        // separate file via `buildSidecar`.
        let footerBuffer: ArrayBuffer | null = null
        if (embedFooter) {
            footerBuffer = this.#writeFooterBuffer(embedFooterDeidentified, options.removeMetadataKeys)
            if (!footerBuffer) {
                Log.error(`Failed to write footer buffer.`, SCOPE)
                this.#locked = false
                return Promise.resolve(null)
            }
            Log.debug(`Footer buffer written, size: ${footerBuffer.byteLength} bytes.`, SCOPE)
        }
        // The data records are written before the header because the container marker names their size.
        const signalBuffer = this.#writeSignalBuffer(options.dither ?? false)
        if (!signalBuffer) {
            Log.error(`Failed to write signal buffer.`, SCOPE)
            this.#locked = false
            return Promise.resolve(null)
        }
        Log.debug(`Signal buffer written, size: ${signalBuffer.byteLength} bytes.`, SCOPE)
        const headerBuffer = this.#writeHeaderBuffer(deidentify, embedFooter, signalBuffer.byteLength)
        if (!headerBuffer) {
            Log.error(`Failed to write header buffer.`, SCOPE)
            this.#locked = false
            return Promise.resolve(null)
        }
        Log.debug(`Header buffer written, size: ${headerBuffer.byteLength} bytes.`, SCOPE)
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
        return Promise.resolve(combinedBuffer)
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

    setHeader (properties?: Partial<BiosignalHeaderRecord>): BiosignalHeaderRecord {
        if (this.#locked) {
            Log.error(`Cannot set header, header properties are locked.`, SCOPE)
            return this.#header ?? this.#emptyHeader()
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
