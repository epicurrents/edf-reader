/**
 * Epicurrents EDF encoder tests — sidecar metadata and de-identification behaviour.
 * @package    epicurrents/edf-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { describe, expect, test } from 'vitest'
import EdfEncoder from '../src/edf/EdfEncoder'
import type { EdfSidecar } from '../src/types'
import type {
    AnnotationEventTemplate,
    AnnotationLabelTemplate,
    BiosignalHeaderRecord,
    BiosignalHeaderSignal,
} from '@epicurrents/core/types'

const event: AnnotationEventTemplate = {
    class: 'event',
    duration: 0,
    priority: 400,
    start: 12,
    text: 'patient John Doe blinked',
    value: 'blink',
    annotator: 'Dr. Smith',
    label: 'blink',
}
const label: AnnotationLabelTemplate = {
    class: 'label',
    priority: 200,
    text: 'recorded at Doe Memorial Hospital',
    value: 'artifact',
    annotator: 'Dr. Smith',
    label: 'artifact',
}

/** Build an encoder with a populated header, one interruption, one event and one label. */
function makeEncoder (): EdfEncoder {
    const encoder = new EdfEncoder('eeg')
    encoder.setHeader({
        patientId: 'John Doe 1975-01-01',
        recordingId: 'EMU visit 2024-03-02',
        recordingStartTime: new Date('2024-03-02T09:30:00.000Z'),
        events: [event],
        labels: [label],
    } as Partial<BiosignalHeaderRecord>)
    encoder.setInterruptions(new Map([[10, 5], [40, 2]]))
    return encoder
}

describe('EdfEncoder sidecar', () => {
    test('original sidecar retains subject identifiers and full event/label text', () => {
        const sidecar = JSON.parse(makeEncoder().buildSidecar()) as EdfSidecar
        expect(sidecar.subject.patientId).toBe('John Doe 1975-01-01')
        expect(sidecar.subject.recordingId).toBe('EMU visit 2024-03-02')
        expect(sidecar.subject.recordingDate).toBe('2024-03-02T09:30:00.000Z')
        expect(sidecar.events[0].text).toBe('patient John Doe blinked')
        expect(sidecar.events[0].annotator).toBe('Dr. Smith')
        expect(sidecar.labels[0].text).toBe('recorded at Doe Memorial Hospital')
        expect(sidecar.version).toBe('1.0')
    })

    test('de-identified sidecar blanks subject and strips event/label text but keeps structure', () => {
        const sidecar = JSON.parse(makeEncoder().buildSidecar({ deidentify: true })) as EdfSidecar
        expect(sidecar.subject.patientId).toBeNull()
        expect(sidecar.subject.recordingId).toBeNull()
        expect(sidecar.subject.recordingDate).toBeNull()
        // Structured events/labels survive, but their free-text and author fields are cleared.
        expect(sidecar.events).toHaveLength(1)
        expect(sidecar.events[0].start).toBe(12)
        expect(sidecar.events[0].text).toBe('')
        expect(sidecar.events[0].annotator).toBeUndefined()
        expect(sidecar.labels).toHaveLength(1)
        expect(sidecar.labels[0].text).toBe('')
    })

    test('interruptions serialize as an array of [start, duration] pairs', () => {
        // A raw Map would serialize to {} through JSON.stringify; the sidecar must emit real pairs.
        const sidecar = JSON.parse(makeEncoder().buildSidecar()) as EdfSidecar
        expect(sidecar.interruptions).toEqual([[10, 5], [40, 2]])
    })

    test('removed metadata keys are left out at any depth and the rest survives', () => {
        const encoder = makeEncoder()
        const parsed = JSON.parse(encoder.buildSidecar({
            deidentify: true,
            removeMetadataKeys: ['subject', 'text', 'annotator', '0'],
        }))
        expect(parsed).not.toHaveProperty('subject')
        expect(parsed.events[0]).not.toHaveProperty('text')
        expect(parsed.labels[0]).not.toHaveProperty('text')
        expect(parsed.events[0].start).toBe(12)
        expect(parsed.events[0].value).toBe('blink')
        // A numeric key never matches an array index.
        expect(parsed.interruptions).toEqual([[10, 5], [40, 2]])
        expect(parsed.version).toBe('1.0')
    })

    test('sidecar excludes free-form annotations', () => {
        const encoder = makeEncoder()
        encoder.setAnnotations([{ class: 'comment', priority: 200, value: 'private note' }])
        const parsed = JSON.parse(encoder.buildSidecar())
        expect(parsed).not.toHaveProperty('annotations')
        // The annotations are still held on the encoder for potential future use.
        expect(encoder.annotations).toHaveLength(1)
    })
})

describe('EdfEncoder embedded footer', () => {
    const RECORDS = 2
    const SAMPLES = 8
    /** The byte size of the header and the data records of the container encoders below: 16-bit samples. */
    const EDF_BYTES = 256 + 256 + SAMPLES*2

    /** An encoder with one signal, one coded event and one interruption, ready to encode. */
    function makeContainerEncoder (discontinuous = false): EdfEncoder {
        const encoder = new EdfEncoder('eeg')
        encoder.setHeader({
            patientId: 'John Doe 1975-01-01',
            recordingId: 'EMU visit 2024-03-02',
            recordingStartTime: new Date('2024-03-02T09:30:00.000Z'),
            dataUnitCount: RECORDS,
            dataUnitDuration: 1,
            discontinuous,
            signalCount: 1,
            signals: [{
                label: 'CH0',
                name: 'CH0',
                modality: 'eeg',
                physicalUnit: '',
                prefiltering: { highpass: null, lowpass: null, notch: null },
                sampleCount: SAMPLES,
                samplingRate: SAMPLES/RECORDS,
                sensitivity: 0,
                sensor: '',
            }] as unknown as BiosignalHeaderSignal[],
            events: [{ ...event, codes: { 'epicurrents.eeg': 'EEG_ACT_EC' } }],
            labels: [],
        } as Partial<BiosignalHeaderRecord>)
        encoder.amplitudeRanges.set(0, [-100, 100])
        encoder.setSignals([new Float32Array(SAMPLES)])
        encoder.setInterruptions(new Map([[1, 3]]))
        return encoder
    }

    function reservedOf (buffer: ArrayBuffer): string {
        return new TextDecoder('ascii').decode(new Uint8Array(buffer, 192, 44)).trim()
    }

    function markerOf (buffer: ArrayBuffer): { total: number, kib: number } {
        const match = reservedOf(buffer).match(/^EDF EC:(\d+):(\d+)$/)
        expect(match).not.toBeNull()
        return { total: Number(match![1]), kib: Number(match![2]) }
    }

    function footerOf (buffer: ArrayBuffer): EdfSidecar {
        const { total, kib } = markerOf(buffer)
        const text = new TextDecoder().decode(new Uint8Array(buffer, total, kib*1024)).replace(/\0+$/, '')
        return JSON.parse(text) as EdfSidecar
    }

    test('a de-identified header carries the placeholder identification, date and time', async () => {
        const buffer = await makeContainerEncoder().encode(true)
        const field = (offset: number, width: number) => {
            return new TextDecoder('ascii').decode(new Uint8Array(buffer!, offset, width)).trim()
        }
        expect(field(8, 80)).toBe('X X X X')
        expect(field(88, 80)).toBe('Startdate X X X X')
        expect(field(168, 8)).toBe('01.01.85')
        expect(field(176, 8)).toBe('00.00.00')
    })

    test('the reserved field marks the container with the EDF size and the footer size', async () => {
        const buffer = await makeContainerEncoder().encode(true, { embedFooter: true })
        expect(buffer).not.toBeNull()
        const { total, kib } = markerOf(buffer!)
        expect(total).toBe(EDF_BYTES)
        expect(kib).toBeGreaterThan(0)
        expect(buffer!.byteLength).toBe(total + kib*1024)
    })

    test('the footer is the sidecar, codes and interruptions included', async () => {
        const encoder = makeContainerEncoder()
        const buffer = await encoder.encode(false, { embedFooter: true })
        const footer = footerOf(buffer!)
        expect(footer).toEqual(JSON.parse(encoder.buildSidecar({ deidentify: false })))
        expect(footer.events[0].codes).toEqual({ 'epicurrents.eeg': 'EEG_ACT_EC' })
        expect(footer.interruptions).toEqual([[1, 3]])
        expect(footer.subject.patientId).toBe('John Doe 1975-01-01')
    })

    test('the footer follows the de-identification asked of it and keeps the codes', async () => {
        const buffer = await makeContainerEncoder().encode(true, { embedFooter: true, embedFooterDeidentified: true })
        const footer = footerOf(buffer!)
        expect(footer.subject.patientId).toBeNull()
        expect(footer.events[0].text).toBe('')
        expect(footer.events[0].codes).toEqual({ 'epicurrents.eeg': 'EEG_ACT_EC' })
    })

    test('the footer leaves out the removed metadata keys and the marker names its reduced size', async () => {
        const buffer = await makeContainerEncoder().encode(true, {
            embedFooter: true,
            embedFooterDeidentified: true,
            removeMetadataKeys: ['subject', 'text'],
        })
        const footer = footerOf(buffer!) as unknown as Record<string, unknown> & { events: Record<string, unknown>[] }
        expect(footer).not.toHaveProperty('subject')
        expect(footer.events[0]).not.toHaveProperty('text')
        expect(footer.events[0].codes).toEqual({ 'epicurrents.eeg': 'EEG_ACT_EC' })
        const { total, kib } = markerOf(buffer!)
        expect(buffer!.byteLength).toBe(total + kib*1024)
    })

    test('a footer channel carries the per-record sample count the header writes', async () => {
        const buffer = await makeContainerEncoder().encode(true, { embedFooter: true })
        // One signal: the samples-per-record field follows the 216 bytes of the signal fields before it.
        const headerCount = new TextDecoder('ascii').decode(new Uint8Array(buffer!, 256 + 216, 8)).trim()
        const channel = footerOf(buffer!).channels[0]
        expect(channel.samplesPerRecord).toBe(Number(headerCount))
        expect(channel.samplesPerRecord).toBe(SAMPLES/RECORDS)
        expect(channel.sampleCount).toBe(SAMPLES)
    })

    test('a discontinuous recording is still a plain EDF container', async () => {
        const buffer = await makeContainerEncoder(true).encode(true, { embedFooter: true })
        expect(reservedOf(buffer!)).toMatch(/^EDF EC:/)
        expect(footerOf(buffer!).interruptions).toEqual([[1, 3]])
    })

    test('without the option the reserved field is standard and nothing follows the records', async () => {
        const buffer = await makeContainerEncoder().encode(true)
        expect(reservedOf(buffer!)).toBe('')
        expect(buffer!.byteLength).toBe(EDF_BYTES)
    })
})

describe('EdfEncoder dither', () => {
    const RATE = 200
    const RECORDS = 3
    const HEADER_BYTES = 256 + 256

    /** An encoder with one channel of a slow sine over ±100, spanning the digital range. */
    function makeSineEncoder (): EdfEncoder {
        const encoder = new EdfEncoder('eeg')
        encoder.setHeader({
            dataUnitCount: RECORDS,
            dataUnitDuration: 1,
            signalCount: 1,
            signals: [{
                label: 'CH0',
                name: 'CH0',
                modality: 'eeg',
                physicalUnit: '',
                prefiltering: { highpass: null, lowpass: null, notch: null },
                sampleCount: RATE*RECORDS,
                samplingRate: RATE,
                sensitivity: 0,
                sensor: '',
            }] as unknown as BiosignalHeaderSignal[],
            events: [],
            labels: [],
        } as Partial<BiosignalHeaderRecord>)
        encoder.amplitudeRanges.set(0, [-100, 100])
        const signal = new Float32Array(RATE*RECORDS)
        for (let i = 0; i < signal.length; i++) {
            signal[i] = 90*Math.sin(i/7)
        }
        encoder.setSignals([signal])
        return encoder
    }

    function samplesOf (buffer: ArrayBuffer): Int16Array {
        return new Int16Array(buffer.slice(HEADER_BYTES))
    }

    test('an undithered export is the same bytes every time', async () => {
        const first = await makeSineEncoder().encode(true)
        const second = await makeSineEncoder().encode(true)
        expect(new Uint8Array(first!)).toEqual(new Uint8Array(second!))
    })

    test('a dithered export differs every time while its header does not', async () => {
        const first = await makeSineEncoder().encode(true, { dither: true })
        const second = await makeSineEncoder().encode(true, { dither: true })
        expect(new Uint8Array(first!, 0, HEADER_BYTES)).toEqual(new Uint8Array(second!, 0, HEADER_BYTES))
        expect(samplesOf(first!)).not.toEqual(samplesOf(second!))
    })

    test('noise for a record longer than one random-source call allows is filled throughout', () => {
        const count = EdfEncoder.RANDOM_WORDS_PER_CALL*2 + 5
        const words = EdfEncoder.randomWords(count)
        expect(words.length).toBe(count)
        // An unfilled stretch would be zeros; a filled one of this length practically never is.
        expect(words.subarray(EdfEncoder.RANDOM_WORDS_PER_CALL*2).some(word => word !== 0)).toBe(true)
        expect(words.subarray(EdfEncoder.RANDOM_WORDS_PER_CALL, EdfEncoder.RANDOM_WORDS_PER_CALL + 64).some(word => word !== 0)).toBe(true)
    })

    test('dither moves no sample by more than one digital step', async () => {
        const plain = samplesOf((await makeSineEncoder().encode(true))!)
        const dithered = samplesOf((await makeSineEncoder().encode(true, { dither: true }))!)
        expect(dithered.length).toBe(plain.length)
        let moved = 0
        for (let i = 0; i < plain.length; i++) {
            expect(Math.abs(dithered[i] - plain[i])).toBeLessThanOrEqual(1)
            if (dithered[i] !== plain[i]) {
                moved++
            }
        }
        // Uniform noise of half a step moves a sample to its other neighbour a quarter of the time on average.
        expect(moved).toBeGreaterThan(plain.length/10)
    })
})

describe('EdfEncoder header fields', () => {
    /** An encoder holding `signals`, with the physical range of each set to `ranges` where given. */
    function encoderWith (
        signals: Partial<BiosignalHeaderSignal>[],
        ranges?: [number, number][],
        recordingStartTime = new Date('2024-03-02T09:30:00.000Z')
    ) {
        const encoder = new EdfEncoder('eeg')
        encoder.setHeader({
            dataUnitCount: 1,
            dataUnitDuration: 1,
            patientId: 'Subject 1',
            recordingId: 'Recording 1',
            recordingStartTime,
            signalCount: signals.length,
            signals: signals.map(signal => ({
                label: 'EEG Fp1',
                modality: 'eeg',
                name: 'Fp1',
                physicalUnit: 'uV',
                prefiltering: { highpass: null, lowpass: null, notch: null },
                sampleCount: 4,
                samplingRate: 4,
                sensitivity: 0,
                sensor: '',
                ...signal,
            })) as BiosignalHeaderSignal[],
        } as never)
        ranges?.forEach((range, i) => encoder.amplitudeRanges.set(i, range))
        encoder.setSignals(signals.map(() => new Float32Array(4)))
        return encoder
    }

    /** Read a fixed-width field out of an encoded header. */
    const field = (buffer: ArrayBuffer, offset: number, width: number) =>
        new TextDecoder().decode(new Uint8Array(buffer, offset, width)).trim()

    test('the header declares the signals it writes, not the ones it was handed', async () => {
        // The annotation channel is never encoded, so counting the header's own signals declared a channel the file
        // does not hold and left a reader parsing the first data record as though it did.
        const encoder = encoderWith([
            { label: 'EEG Fp1' },
            { label: 'EDF Annotations', physicalUnit: '' },
        ])
        const buffer = (await encoder.encode()) as ArrayBuffer
        expect(field(buffer, 252, 4)).toBe('1')
        expect(field(buffer, 184, 8)).toBe('512')
        // One signal block after the fixed header, and the data records follow it immediately.
        expect(field(buffer, 256, 16)).toBe('EEG Fp1')
        expect(buffer.byteLength).toBe(512 + 4*2)
    })

    test('a physical range too long for its field is rounded to fit rather than cut short', async () => {
        const encoder = encoderWith([{}], [[-123.456789012345, 123.456789012345]])
        const buffer = (await encoder.encode()) as ArrayBuffer
        const physMin = field(buffer, 256 + 16 + 80 + 8, 8)
        const physMax = field(buffer, 256 + 16 + 80 + 8 + 8, 8)
        expect(physMin.length).toBeLessThanOrEqual(8)
        expect(parseFloat(physMin)).toBeCloseTo(-123.456789, 2)
        expect(parseFloat(physMax)).toBeCloseTo(123.456789, 2)
    })

    test('a magnitude below what a decimal field holds keeps its sign and its order', async () => {
        // `(-1.2345e-7).toString()` is ten characters, whose first eight parse back as 1.2345: sign gone, magnitude
        // out by seven orders. The field has to stay readable as the number it stands for.
        const encoder = encoderWith([{}], [[-1.2345e-7, 1.2345e-7]])
        const buffer = (await encoder.encode()) as ArrayBuffer
        const physMin = parseFloat(field(buffer, 256 + 16 + 80 + 8, 8))
        expect(physMin).toBeLessThan(0)
        expect(Math.abs(physMin)).toBeGreaterThan(1e-8)
        expect(Math.abs(physMin)).toBeLessThan(1e-6)
    })

    test('the recording start is written in local time, as the format states it', async () => {
        // The fields are `dd.mm.yy` and `hh.mm.ss` of the recording's own local time, which is how the decoder reads
        // them back. Building them by slicing an ISO string whose separators had been replaced rather than removed
        // put every character in the wrong place; the only date assertion the suite had was on the de-identified
        // branch, which takes neither path, so a corrupt field went unnoticed on every other export.
        const start = new Date(2024, 2, 2, 9, 30, 45)
        const buffer = (await encoderWith([{}], [[-100, 100]], start).encode()) as ArrayBuffer
        expect(field(buffer, 168, 8)).toBe('02.03.24')
        expect(field(buffer, 176, 8)).toBe('09.30.45')
    })

    test('a start outside the years the two-digit field spans is written as the placeholder', async () => {
        const buffer = (await encoderWith([{}], [[-100, 100]], new Date(2090, 0, 1, 0, 0, 0)).encode()) as ArrayBuffer
        // The EDF+ convention leaves the real date to the recording identification field.
        expect(field(buffer, 168, 8)).toBe('01.01.yy')
    })

    test('a character outside ASCII is written as a space rather than as an unrelated byte', async () => {
        // `setUint8` stores the low byte of a code point, so a Greek mu would otherwise be written as `¼`.
        const encoder = encoderWith([{ physicalUnit: '\u03bcV' }])
        const buffer = (await encoder.encode()) as ArrayBuffer
        expect(field(buffer, 256 + 16 + 80, 8)).toBe('V')
    })
})
