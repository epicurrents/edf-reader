/**
 * Epicurrents EDF exporter tests — resource → de-identified EDF + sidecar, including unit conversion and round-trip.
 * @package    epicurrents/edf-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { describe, expect, test, vi } from 'vitest'
import EdfDecoder from '../src/edf/EdfDecoder'
import EdfExporter from '../src/edf/EdfExporter'
import type { EdfSidecar } from '../src/types'
import type { BiosignalResource } from '@epicurrents/core/types'

const RECORD_COUNT = 3
const CHANNELS = [
    { rate: 4, unit: 'uV', rangeUv: [-100, 100] as [number, number] },
    { rate: 2, unit: 'uV', rangeUv: [-500, 500] as [number, number] },
]
/** Micro-volt to volt scale — the viewer stores biosignals in base units (volts). */
const UV = 1e-6

/** A deterministic ramp across the physical range, stored in base units (volts). */
function makeVoltSignal (rate: number, rangeUv: [number, number]): Float32Array {
    const total = rate*RECORD_COUNT
    const data = new Float32Array(total)
    const [min, max] = rangeUv
    for (let i = 0; i < total; i++) {
        data[i] = (min + ((max - min)*i)/(total - 1))*UV
    }
    return data
}

/** Build a minimal fake resource carrying everything `encodeResource` reads. */
function makeResource (): BiosignalResource {
    const channels = CHANNELS.map((c, i) => ({
        label: `CH${i}`,
        name: `CH${i}`,
        modality: 'eeg',
        unit: c.unit,
        samplingRate: c.rate,
        sampleCount: c.rate*RECORD_COUNT,
        sensitivity: 0,
        highpassFilter: null,
        lowpassFilter: null,
        notchFilter: null,
        signal: makeVoltSignal(c.rate, c.rangeUv),
    }))
    return {
        channels,
        events: [],
        labels: [],
        interruptions: [],
        modality: 'eeg',
        name: 'subject-recording.edf',
        startTime: new Date('2024-03-02T09:30:00.000Z'),
        source: {
            meta: {
                header: {
                    patientId: 'Jane Doe 1975',
                    recordingId: 'EMU 2024',
                    recordingStartTime: new Date('2024-03-02T09:30:00.000Z'),
                },
            },
        },
        getAllRawSignals: async () => null,
    } as unknown as BiosignalResource
}

function decode (edf: ArrayBuffer) {
    const decoder = new EdfDecoder()
    decoder.setInput(edf)
    const decoded = decoder.decode()
    return { decoded, header: decoder.output }
}

describe('EdfExporter.encodeResource', () => {
    test('round-trips physical signals through volt → µV conversion within quantization tolerance', async () => {
        const resource = makeResource()
        const result = await new EdfExporter().encodeResource(resource, { deidentify: false })
        expect(result).not.toBeNull()

        const { decoded, header } = decode(result!.edf)
        expect(decoded).not.toBeNull()
        expect(header.signalCount).toBe(CHANNELS.length)
        expect(header.dataUnitCount).toBe(RECORD_COUNT)

        for (let s = 0; s < CHANNELS.length; s++) {
            const original = resource.channels[s].signal as Float32Array
            const tolerance = ((CHANNELS[s].rangeUv[1] - CHANNELS[s].rangeUv[0])/65535)*UV + 1e-12
            for (let i = 0; i < original.length; i++) {
                expect(Math.abs(decoded!.data[s][i] - original[i])).toBeLessThanOrEqual(tolerance)
            }
        }
    })

    test('not de-identified export keeps the subject id in the header; the sidecar keeps the originals', async () => {
        const result = await new EdfExporter().encodeResource(makeResource(), { deidentify: false })
        const { header } = decode(result!.edf)
        expect(header.patientId).toContain('Jane Doe 1975')
        const sidecar = JSON.parse(result!.sidecar) as EdfSidecar
        expect(sidecar.subject.patientId).toBe('Jane Doe 1975')
        expect(sidecar.subject.recordingId).toBe('EMU 2024')
    })

    test('de-identified export blanks the header subject but the sidecar still carries the originals', async () => {
        const result = await new EdfExporter().encodeResource(makeResource(), { deidentify: true })
        const { header } = decode(result!.edf)
        expect(header.patientId).toContain('X X X X')
        // The sidecar defaults to preserving the originals (it is the re-identification key).
        const sidecar = JSON.parse(result!.sidecar) as EdfSidecar
        expect(sidecar.subject.patientId).toBe('Jane Doe 1975')
    })

    test('excludes meta/annotation channels from the exported signals', async () => {
        const resource = makeResource()
        // Append an EDF Annotations-style meta channel with no numeric signal — it must not break the export.
        ;(resource.channels as unknown[]).push({
            label: 'EDF Annotations',
            name: 'EDF Annotations',
            modality: 'meta',
            unit: '',
            samplingRate: 0,
            sampleCount: 0,
            sensitivity: 0,
            highpassFilter: null,
            lowpassFilter: null,
            notchFilter: null,
            signal: new Float32Array(0),
        })
        const result = await new EdfExporter().encodeResource(resource, { deidentify: false })
        expect(result).not.toBeNull()
        const { header } = decode(result!.edf)
        // Only the real signal channels are encoded; the meta channel is dropped.
        expect(header.signalCount).toBe(CHANNELS.length)
    })

    test('preserves channel labels when de-identifying and derives modality', async () => {
        const result = await new EdfExporter().encodeResource(makeResource(), { deidentify: true })
        const { header } = decode(result!.edf)
        // Labels are technical metadata (montages match on them) and must survive de-identification, not become "??".
        expect(header.getSignalLabel(0)).toContain('CH0')
        expect(header.getSignalLabel(1)).toContain('CH1')
        // Modality is derived (here falling back to the recording modality 'eeg'), not the generic source 'signal'.
        const sidecar = JSON.parse(result!.sidecar) as EdfSidecar
        expect(sidecar.channels[0].modality).toBe('eeg')
    })

    test('deidentifySidecar also blanks the sidecar subject', async () => {
        const result = await new EdfExporter().encodeResource(
            makeResource(), { deidentify: true, deidentifySidecar: true }
        )
        const sidecar = JSON.parse(result!.sidecar) as EdfSidecar
        expect(sidecar.subject.patientId).toBeNull()
    })
})

describe('EdfExporter sidecar templates and the container', () => {
    /** A live event as the resource holds one: the template fields plus asset state that must not be exported. */
    const liveEvent = {
        _codes: { 'epicurrents.eeg': 'EEG_ACT_HV' },
        annotator: 'Dr. Smith',
        background: false,
        channels: [],
        class: 'activation',
        codes: { 'epicurrents.eeg': 'EEG_ACT_HV' },
        duration: 30,
        id: 'asset-id',
        label: 'HV',
        locked: true,
        name: 'q1',
        priority: 300,
        start: 60,
        text: 'strong effort',
        value: 'Hyperventilation',
        visible: false,
    }
    const liveLabel = {
        annotator: '',
        class: 'evaluation',
        codes: {},
        id: 'asset-id-2',
        label: '',
        locked: false,
        priority: 300,
        text: '',
        value: 'normal',
        visible: true,
    }

    function makeAnnotatedResource (): BiosignalResource {
        const resource = makeResource()
        ;(resource as unknown as { events: unknown[] }).events = [liveEvent]
        ;(resource as unknown as { labels: unknown[] }).labels = [liveLabel]
        return resource
    }

    test('events and labels reach the sidecar as templates with their codes and none of the asset state', async () => {
        const result = await new EdfExporter().encodeResource(makeAnnotatedResource(), { deidentify: false })
        const sidecar = JSON.parse(result!.sidecar) as EdfSidecar
        expect(sidecar.events).toEqual([{
            annotator: 'Dr. Smith',
            background: false,
            channels: [],
            class: 'activation',
            codes: { 'epicurrents.eeg': 'EEG_ACT_HV' },
            duration: 30,
            label: 'HV',
            locked: true,
            name: 'q1',
            priority: 300,
            start: 60,
            text: 'strong effort',
            value: 'Hyperventilation',
            visible: false,
        }])
        expect(sidecar.labels).toEqual([{ class: 'evaluation', priority: 300, value: 'normal' }])
    })

    test('embedFooter appends the sidecar as a footer, de-identified with the file, and marks the header', async () => {
        const result = await new EdfExporter().encodeResource(
            makeAnnotatedResource(), { deidentify: true, embedFooter: true }
        )
        const reserved = new TextDecoder('ascii').decode(new Uint8Array(result!.edf, 192, 44)).trim()
        const match = reserved.match(/^EDF EC:(\d+):(\d+)$/)
        expect(match).not.toBeNull()
        const total = Number(match![1])
        const kib = Number(match![2])
        expect(result!.edf.byteLength).toBe(total + kib*1024)
        const text = new TextDecoder().decode(new Uint8Array(result!.edf, total, kib*1024)).replace(/\0+$/, '')
        const footer = JSON.parse(text) as EdfSidecar
        expect(footer.subject.patientId).toBeNull()
        expect(footer.events[0].codes).toEqual({ 'epicurrents.eeg': 'EEG_ACT_HV' })
        expect(footer.events[0].text).toBe('')
        // The separate sidecar keeps its own default and still carries the originals.
        expect((JSON.parse(result!.sidecar) as EdfSidecar).subject.patientId).toBe('Jane Doe 1975')
        // The EDF part still decodes as an ordinary recording.
        const { header } = decode(result!.edf)
        expect(header.dataUnitCount).toBe(RECORD_COUNT)
    })

    test('without embedFooter the file ends with its last data record', async () => {
        const exporter = new EdfExporter()
        const plain = await exporter.encodeResource(makeAnnotatedResource(), { deidentify: true })
        const container = await exporter.encodeResource(
            makeAnnotatedResource(), { deidentify: true, embedFooter: true }
        )
        const reserved = new TextDecoder('ascii').decode(new Uint8Array(container!.edf, 192, 44)).trim()
        const total = Number(reserved.match(/^EDF EC:(\d+):/)![1])
        expect(plain!.edf.byteLength).toBe(total)
        expect(new Uint8Array(plain!.edf, 192, 44).every(byte => byte === 32)).toBe(true)
    })
})

describe('EdfExporter.convertResource', () => {
    test('caches the resource signals, then encodes it', async () => {
        const resource = makeResource()
        const loadAndCacheSignals = vi.fn().mockResolvedValue(true)
        ;(resource as unknown as { loadAndCacheSignals: unknown }).loadAndCacheSignals = loadAndCacheSignals
        const result = await new EdfExporter().convertResource(resource, { deidentify: false })
        expect(loadAndCacheSignals).toHaveBeenCalledTimes(1)
        expect(result).not.toBeNull()
        const { header } = decode(result!.edf)
        expect(header.signalCount).toBe(CHANNELS.length)
    })

    test('returns null without encoding when caching fails', async () => {
        const resource = makeResource()
        const loadAndCacheSignals = vi.fn().mockResolvedValue(false)
        ;(resource as unknown as { loadAndCacheSignals: unknown }).loadAndCacheSignals = loadAndCacheSignals
        const result = await new EdfExporter().convertResource(resource)
        expect(result).toBeNull()
    })
})
