/**
 * A byte-level EDF/BDF builder for the reader tests. The encoder cannot serve here: it writes only continuous EDF with
 * no annotation channel, and the reading side's intricate parts — the TAL state machine, interruption detection and
 * the three-byte BDF sample — are exactly what it never produces.
 * @package    epicurrents/edf-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

/** A signal as the header describes it, with its digital samples given record by record. */
export type TestSignal = {
    digital: [number, number]
    label: string
    physical: [number, number]
    prefiltering?: string
    /** Digital samples per data record; each entry is one record. */
    records: number[][]
    transducer?: string
    unit: string
}

export type TestFile = {
    /** Annotation channel contents, one TAL string per data record. A file with none has no annotation channel. */
    annotations?: string[]
    format?: 'edf' | 'bdf'
    patientId?: string
    /** `false` for plain EDF/BDF, `'C'` for continuous and `'D'` for discontinuous EDF+/BDF+. */
    plus?: false | 'C' | 'D'
    recordDuration?: number
    recordingId?: string
    signals: TestSignal[]
    /** Recording start as `dd.mm.yy` and `hh.mm.ss`, the fields' own spelling. */
    startDate?: string
    startTime?: string
}

/** TAL field separators: 20 ends a field, 21 precedes a duration, 0 ends an annotation. */
export const TAL_END = '\x14'
export const TAL_DURATION = '\x15'
export const TAL_TERMINATOR = '\x00'

/**
 * The timekeeping annotation every EDF+ data record opens with, optionally followed by text annotations.
 * @param onset - Record start in seconds of recording time, as the record itself states it.
 * @param events - Text annotations to follow it with, each `[start, duration, text]`; a duration of null omits one.
 */
export const recordTal = (onset: number, events: [number, number | null, string][] = []) => {
    const sign = onset < 0 ? '' : '+'
    let tal = `${sign}${onset}${TAL_END}${TAL_END}${TAL_TERMINATOR}`
    for (const [start, duration, text] of events) {
        const startField = `${start < 0 ? '' : '+'}${start}`
        tal += duration === null
               ? `${startField}${TAL_END}${text}${TAL_END}${TAL_TERMINATOR}`
               : `${startField}${TAL_DURATION}${duration}${TAL_END}${text}${TAL_END}${TAL_TERMINATOR}`
    }
    return tal
}

/** Write `text` into a fixed-width ASCII field, space-padded and truncated to `width`. */
const field = (text: string, width: number) => {
    const bytes = new Array<number>(width).fill(32)
    for (let i = 0; i < Math.min(text.length, width); i++) {
        bytes[i] = text.charCodeAt(i)
    }
    return bytes
}

/**
 * Build an EDF or BDF file from the given description.
 * @param spec - What the file should contain.
 * @returns The file as bytes, header record and data records together.
 */
export const buildEdf = (spec: TestFile): ArrayBuffer => {
    const format = spec.format ?? 'edf'
    const sampleBytes = format === 'bdf' ? 3 : 2
    const recordDuration = spec.recordDuration ?? 1
    const recordCount = spec.signals[0]?.records.length ?? spec.annotations?.length ?? 0
    // The annotation channel's samples are its TAL bytes; the widest record fixes the channel's width, and every
    // record is padded to it with nulls, which is what the format asks for.
    const annotationBytes = spec.annotations?.map(tal => new TextEncoder().encode(tal)) ?? []
    const annotationSamples = annotationBytes.length
                              ? Math.ceil(Math.max(...annotationBytes.map(b => b.length))/sampleBytes)
                              : 0
    const signals = spec.signals.map(signal => ({ ...signal, samplesPerRecord: signal.records[0]?.length ?? 0 }))
    const signalCount = signals.length + (annotationSamples ? 1 : 0)
    const headerBytes = 256 + signalCount*256
    const header = [] as number[]
    if (format === 'bdf') {
        header.push(255, ...field('BIOSEMI', 7))
    } else {
        header.push(...field('0', 8))
    }
    header.push(...field(spec.patientId ?? 'X X X X', 80))
    header.push(...field(spec.recordingId ?? 'Startdate X X X X', 80))
    header.push(...field(spec.startDate ?? '02.03.24', 8))
    header.push(...field(spec.startTime ?? '09.30.00', 8))
    header.push(...field(`${headerBytes}`, 8))
    header.push(...field(spec.plus ? `${format.toUpperCase()}+${spec.plus}` : '', 44))
    header.push(...field(`${recordCount}`, 8))
    header.push(...field(`${recordDuration}`, 8))
    header.push(...field(`${signalCount}`, 4))
    const annotationLabel = `${format.toUpperCase()} Annotations`
    const labels = [...signals.map(s => s.label), ...(annotationSamples ? [annotationLabel] : [])]
    const perSignal: [number, (index: number) => string][] = [
        [16, i => labels[i]],
        [80, i => signals[i]?.transducer ?? ''],
        [8, i => signals[i]?.unit ?? ''],
        [8, i => `${signals[i]?.physical[0] ?? -1}`],
        [8, i => `${signals[i]?.physical[1] ?? 1}`],
        [8, i => `${signals[i]?.digital[0] ?? -32768}`],
        [8, i => `${signals[i]?.digital[1] ?? 32767}`],
        [80, i => signals[i]?.prefiltering ?? ''],
        [8, i => `${signals[i]?.samplesPerRecord ?? annotationSamples}`],
        [32, () => ''],
    ]
    for (const [width, value] of perSignal) {
        for (let i = 0; i < signalCount; i++) {
            header.push(...field(value(i), width))
        }
    }
    const recordBytes = signals.reduce((total, s) => total + s.samplesPerRecord*sampleBytes, 0)
                        + annotationSamples*sampleBytes
    const buffer = new ArrayBuffer(headerBytes + recordBytes*recordCount)
    const bytes = new Uint8Array(buffer)
    bytes.set(header)
    let offset = headerBytes
    for (let record = 0; record < recordCount; record++) {
        for (const signal of signals) {
            for (const sample of signal.records[record]) {
                // Two's complement, little endian, in the format's sample width.
                const value = sample < 0 ? sample + (1 << (8*sampleBytes)) : sample
                for (let b = 0; b < sampleBytes; b++) {
                    bytes[offset++] = (value >> (8*b)) & 0xff
                }
            }
        }
        if (annotationSamples) {
            bytes.set(annotationBytes[record] ?? new Uint8Array(0), offset)
            offset += annotationSamples*sampleBytes
        }
    }
    return buffer
}
