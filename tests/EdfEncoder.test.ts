/**
 * Epicurrents EDF encoder tests — sidecar metadata and anonymization behaviour.
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
} from '@epicurrents/core/dist/types'

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

    test('anonymized sidecar blanks subject and strips event/label text but keeps structure', () => {
        const sidecar = JSON.parse(makeEncoder().buildSidecar({ anonymize: true })) as EdfSidecar
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

    test('sidecar excludes free-form annotations', () => {
        const encoder = makeEncoder()
        encoder.setAnnotations([{ class: 'comment', priority: 200, value: 'private note' }])
        const parsed = JSON.parse(encoder.buildSidecar())
        expect(parsed).not.toHaveProperty('annotations')
        // The annotations are still held on the encoder for potential future use.
        expect(encoder.annotations).toHaveLength(1)
    })
})
