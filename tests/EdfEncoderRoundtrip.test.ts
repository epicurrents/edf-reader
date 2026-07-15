/**
 * Epicurrents EDF encoder round-trip tests — encode physical signals, decode them back, compare.
 * @package    epicurrents/edf-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { describe, expect, test } from 'vitest'
import EdfDecoder from '../src/edf/EdfDecoder'
import EdfEncoder from '../src/edf/EdfEncoder'
import type { BiosignalHeaderRecord, BiosignalHeaderSignal } from '@epicurrents/core/dist/types'

const RECORD_COUNT = 3
/** Two signals at different sampling rates, so per-record striding is actually exercised. */
const SIGNALS: { rate: number, range: [number, number] }[] = [
    { rate: 4, range: [-100, 100] },
    { rate: 2, range: [-500, 500] },
]

function makeSignal (rate: number, range: [number, number]): Float32Array {
    const total = rate*RECORD_COUNT
    const data = new Float32Array(total)
    const [min, max] = range
    for (let i = 0; i < total; i++) {
        // A deterministic ramp across the physical range.
        data[i] = min + ((max - min)*i)/(total - 1)
    }
    return data
}

function makeHeaderSignals (): BiosignalHeaderSignal[] {
    return SIGNALS.map((s, i) => ({
        label: `CH${i}`,
        name: `CH${i}`,
        modality: 'eeg',
        // Unitless so the decoder's unit normalization (e.g. µV → V) is out of scope; this isolates the encoder's
        // physical→digital quantization. Unit-aware scaling is the exporter's concern (it converts base-unit resource
        // signals into the display unit before encoding).
        physicalUnit: '',
        prefiltering: { highpass: null, lowpass: null, notch: null },
        sampleCount: s.rate*RECORD_COUNT,
        samplingRate: s.rate,
        sensitivity: 0,
        sensor: '',
    })) as unknown as BiosignalHeaderSignal[]
}

describe('EdfEncoder round-trip', () => {
    test('physical signals survive an encode → decode cycle within quantization tolerance', async () => {
        const encoder = new EdfEncoder('eeg')
        encoder.setHeader({
            patientId: 'RoundTrip Subject',
            recordingId: 'RoundTrip Recording',
            recordingStartTime: new Date('2024-03-02T09:30:00.000Z'),
            dataUnitCount: RECORD_COUNT,
            dataUnitDuration: 1,
            signalCount: SIGNALS.length,
            signals: makeHeaderSignals(),
        } as Partial<BiosignalHeaderRecord>)
        SIGNALS.forEach((s, i) => encoder.amplitudeRanges.set(i, s.range))
        const original = SIGNALS.map(s => makeSignal(s.rate, s.range))
        encoder.setSignals(original)

        const buffer = await encoder.encode()
        expect(buffer).not.toBeNull()

        const decoder = new EdfDecoder()
        decoder.setInput(buffer as ArrayBuffer)
        const decoded = decoder.decode()
        expect(decoded).not.toBeNull()

        const header = decoder.output
        expect(header.signalCount).toBe(SIGNALS.length)
        expect(header.dataUnitCount).toBe(RECORD_COUNT)

        const signals = decoded!.data
        expect(signals).toHaveLength(SIGNALS.length)
        for (let s = 0; s < SIGNALS.length; s++) {
            const [min, max] = SIGNALS[s].range
            const tolerance = (max - min)/65535 + 1e-6 // One quantization step.
            expect(signals[s]).toHaveLength(SIGNALS[s].rate*RECORD_COUNT)
            for (let i = 0; i < original[s].length; i++) {
                expect(Math.abs(signals[s][i] - original[s][i])).toBeLessThanOrEqual(tolerance)
            }
        }
    })
})
