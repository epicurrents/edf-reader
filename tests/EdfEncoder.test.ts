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
