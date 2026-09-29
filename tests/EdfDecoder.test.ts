/**
 * Epicurrents EDF decoder tests: the reading half of the package, which every recording the viewer opens passes
 * through. The header fields, the digital-to-physical conversion, the EDF+ annotation records and the three-byte BDF
 * sample are each read from bytes built for the purpose.
 * @package    epicurrents/edf-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { describe, expect, test } from 'vitest'
import EdfDecoder from '../src/edf/EdfDecoder'
import EdfEncoder from '../src/edf/EdfEncoder'
import { buildEdf, recordTal, type TestSignal } from './edfFile'

/** A signal whose digital samples run 0, 1, 2 … within each record. */
const rampSignal = (records: number, samplesPerRecord: number, overrides: Partial<TestSignal> = {}): TestSignal => ({
    digital: [-32768, 32767],
    label: 'EEG Fp1',
    physical: [-100, 100],
    records: Array.from({ length: records }, (_r, r) =>
        Array.from({ length: samplesPerRecord }, (_s, s) => r*samplesPerRecord + s)),
    unit: 'uV',
    ...overrides,
})

describe('EdfDecoder header', () => {
    test('reads the fixed fields and the per-signal block of an EDF file', () => {
        const decoder = new EdfDecoder(buildEdf({
            patientId: 'Subject 1',
            recordingId: 'Recording 1',
            signals: [rampSignal(2, 4, { prefiltering: 'HP:0.5Hz LP:70Hz N:50Hz', transducer: 'AgAgCl electrode' })],
            startDate: '02.03.24',
            startTime: '09.30.00',
        }))
        const header = decoder.decodeHeader()
        expect(header).toBeTruthy()
        expect(header?.dataFormat).toBe('edf')
        expect(header?.isPlus).toBe(false)
        expect(header?.patientId).toBe('Subject 1')
        expect(header?.localRecordingId).toBe('Recording 1')
        expect(header?.dataRecordCount).toBe(2)
        expect(header?.dataRecordDuration).toBe(1)
        expect(header?.signalCount).toBe(1)
        expect(header?.headerRecordBytes).toBe(512)
        // Two-byte samples: four per record.
        expect(header?.recordByteSize).toBe(8)
        expect(header?.recordingDate?.toISOString()).toBe(new Date(2024, 2, 2, 9, 30, 0).toISOString())
        const signal = header!.signalInfo[0]
        expect(signal.label).toBe('EEG Fp1')
        expect(signal.transducerType).toBe('AgAgCl electrode')
        expect(signal.physicalUnit).toBe('uV')
        expect(signal.sampleCount).toBe(4)
        expect(signal.samplingRate).toBe(4)
        expect(signal.unitsPerBit).toBeCloseTo(200/65535, 12)
    })

    test('a BDF record is half again as wide as an EDF one of the same samples', () => {
        const signals = [rampSignal(2, 4, { digital: [-8388608, 8388607] })]
        const edf = new EdfDecoder(buildEdf({ signals })).decodeHeader()
        const bdf = new EdfDecoder(buildEdf({ format: 'bdf', signals })).decodeHeader()
        expect(edf?.dataFormat).toBe('edf')
        expect(bdf?.dataFormat).toBe('bdf')
        expect(edf?.recordByteSize).toBe(8)
        expect(bdf?.recordByteSize).toBe(12)
    })

    test('the reserved field marks an EDF+ file and its continuity', () => {
        const signals = [rampSignal(2, 4)]
        const continuous = new EdfDecoder(buildEdf({ plus: 'C', signals })).decodeHeader()
        const discontinuous = new EdfDecoder(buildEdf({ plus: 'D', signals })).decodeHeader()
        expect(continuous?.isPlus).toBe(true)
        expect(continuous?.discontinuous).toBe(false)
        expect(continuous?.dataFormat).toBe('edf+')
        expect(discontinuous?.isPlus).toBe(true)
        expect(discontinuous?.discontinuous).toBe(true)
    })

    test('an annotation channel is given no sampling rate, whichever format names it', () => {
        for (const format of ['edf', 'bdf'] as const) {
            const header = new EdfDecoder(buildEdf({
                annotations: [recordTal(0), recordTal(1)],
                format,
                plus: 'C',
                signals: [rampSignal(2, 4)],
            })).decodeHeader()
            const annotations = header!.signalInfo[1]
            expect(annotations.label).toBe(`${format.toUpperCase()} Annotations`)
            expect(annotations.samplingRate).toBe(0)
            expect(header!.signalInfo[0].samplingRate).toBe(4)
        }
    })

    test('a signal whose digital range is a single value is refused rather than decoded as NaN', () => {
        const decoder = new EdfDecoder(buildEdf({ signals: [rampSignal(1, 2, { digital: [100, 100] })] }))
        expect(decoder.decodeHeader()).toBeNull()
    })

    test('a buffer that stops inside the signal block is refused', () => {
        const full = buildEdf({ signals: [rampSignal(1, 2), rampSignal(1, 2, { label: 'EEG Fp2' })] })
        // The header record needs 768 bytes for two signals. Reading past the end of a short buffer yields
        // replacement characters rather than an error, so the shortfall has to be noticed before the parse.
        expect(new EdfDecoder(full.slice(0, 767)).decodeHeader()).toBeNull()
        expect(new EdfDecoder(full.slice(0, 300)).decodeHeader()).toBeNull()
        // The fixed part alone is enough when the signal block is not wanted.
        expect(new EdfDecoder(full.slice(0, 256)).decodeHeader(true)).toBeTruthy()
    })

    test('a file that is neither EDF nor BDF is refused', () => {
        const bytes = new Uint8Array(512).fill(32)
        expect(new EdfDecoder(bytes.buffer).decodeHeader()).toBeNull()
    })
})

describe('EdfDecoder data', () => {
    test('digital samples become physical values in the signal unit', () => {
        const decoder = new EdfDecoder(buildEdf({
            signals: [{
                digital: [-32768, 32767],
                label: 'EEG Fp1',
                physical: [-100, 100],
                records: [[-32768, 0, 32767, 16384]],
                unit: 'uV',
            }],
        }))
        const header = decoder.decodeHeader()
        const data = decoder.decodeData(header)
        // The physical values are read in the signal's own unit and then scaled to the base unit, so µV become volts.
        const scale = 1e-6
        const step = (200/65535)*scale
        expect(data?.signals[0][0]).toBeCloseTo(-100*scale, 12)
        expect(data?.signals[0][2]).toBeCloseTo(100*scale, 12)
        // The digital range is asymmetric, so digital zero sits half a step above the physical midpoint rather than
        // on it. Asserting an exact zero here would be asserting a conversion the format does not describe.
        expect(Math.abs(data!.signals[0][1] - step/2)).toBeLessThan(step/1000)
        expect(Math.abs(data!.signals[0][3] - 50*scale)).toBeLessThan(step)
    })

    test('a BDF sample is read three bytes at a time', () => {
        const decoder = new EdfDecoder(buildEdf({
            format: 'bdf',
            signals: [{
                digital: [-8388608, 8388607],
                label: 'EEG Fp1',
                physical: [-100, 100],
                records: [[-8388608, 0, 8388607]],
                unit: 'uV',
            }],
        }))
        const header = decoder.decodeHeader()
        const data = decoder.decodeData(header)
        expect(data?.signals[0]).toHaveLength(3)
        expect(data?.signals[0][0]).toBeCloseTo(-100e-6, 12)
        expect(data?.signals[0][2]).toBeCloseTo(100e-6, 12)
    })

    test('signals of different rates are separated from the interleaved records', () => {
        // Each record holds four samples of the first signal followed by two of the second, and the decoder has to
        // walk that stride to put each signal's records back together in order.
        const decoder = new EdfDecoder(buildEdf({
            signals: [
                rampSignal(3, 4),
                rampSignal(3, 2, { label: 'ECG', physical: [-5, 5], unit: 'mV' }),
            ],
        }))
        const header = decoder.decodeHeader()
        const data = decoder.decodeData(header, undefined, -1, 0, undefined, 0, true)
        expect(Array.from(data!.signals[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
        expect(Array.from(data!.signals[1])).toEqual([0, 1, 2, 3, 4, 5])
    })
})

describe('EdfDecoder annotations', () => {
    test('a text annotation reaches the events with its start, duration and text', () => {
        const decoder = new EdfDecoder(buildEdf({
            annotations: [
                recordTal(0, [[0.5, 1.25, 'Eyes closed']]),
                recordTal(1, [[1.5, null, 'Photic 10 Hz']]),
            ],
            plus: 'C',
            signals: [rampSignal(2, 4)],
        }))
        const header = decoder.decodeHeader()
        const data = decoder.decodeData(header)
        expect(data?.events).toHaveLength(2)
        expect(data?.events[0]).toMatchObject({ duration: 1.25, label: 'Eyes closed', start: 0.5 })
        // An annotation given no duration is an instant.
        expect(data?.events[1]).toMatchObject({ duration: 0, label: 'Photic 10 Hz', start: 1.5 })
    })

    test('several annotations in one record are all read', () => {
        const decoder = new EdfDecoder(buildEdf({
            annotations: [recordTal(0, [[0.1, null, 'First'], [0.2, 0.3, 'Second'], [0.4, null, 'Third']])],
            plus: 'C',
            signals: [rampSignal(1, 4)],
        }))
        const header = decoder.decodeHeader()
        const data = decoder.decodeData(header)
        expect(data?.events.map(e => e.label)).toEqual(['First', 'Second', 'Third'])
    })

    test('the annotation channel decodes as zeros rather than as a signal', () => {
        const decoder = new EdfDecoder(buildEdf({
            annotations: [recordTal(0, [[0.5, null, 'Eyes closed']])],
            plus: 'C',
            signals: [rampSignal(1, 4)],
        }))
        const header = decoder.decodeHeader()
        const data = decoder.decodeData(header)
        expect(data?.signals[1].every(sample => sample === 0)).toBe(true)
    })

    test('a record starting later than its place in the file records an interruption', () => {
        // The third record opens at 12 s where the file's own timeline puts it at 2 s: a ten-second gap before it.
        const decoder = new EdfDecoder(buildEdf({
            annotations: [recordTal(0), recordTal(1), recordTal(12)],
            plus: 'D',
            signals: [rampSignal(3, 4)],
        }))
        const header = decoder.decodeHeader()
        const data = decoder.decodeData(header)
        expect([...data!.interruptions.entries()]).toEqual([[2, 10]])
    })

    test('interruptions accumulate, so each is measured against the records before it', () => {
        const decoder = new EdfDecoder(buildEdf({
            annotations: [recordTal(0), recordTal(5), recordTal(11)],
            plus: 'D',
            signals: [rampSignal(3, 4)],
        }))
        const header = decoder.decodeHeader()
        const data = decoder.decodeData(header)
        // Four seconds before the second record, and five more before the third.
        expect([...data!.interruptions.entries()]).toEqual([[1, 4], [2, 5]])
    })

    test('a continuous file records no interruption, whatever its record timestamps say', () => {
        const decoder = new EdfDecoder(buildEdf({
            annotations: [recordTal(0), recordTal(1), recordTal(12)],
            plus: 'C',
            signals: [rampSignal(3, 4)],
        }))
        const header = decoder.decodeHeader()
        const data = decoder.decodeData(header)
        expect(data?.interruptions.size).toBe(0)
    })
})

describe('EdfDecoder against the encoder', () => {
    test('a file the builder writes decodes the same as one the encoder writes', async () => {
        // The reader tests are only as good as the bytes they are given, and a builder written beside the decoder can
        // share a wrong idea of the layout with it. The encoder was written independently of both, so agreement
        // between the two writers is what says the layout is the format's rather than this package's.
        const RECORDS = 3
        const RATE = 4
        const physical: [number, number] = [-100, 100]
        const samples = Array.from({ length: RECORDS*RATE }, (_v, i) => -100 + (200*i)/(RECORDS*RATE - 1))
        const encoder = new EdfEncoder('eeg')
        encoder.setHeader({
            dataUnitCount: RECORDS,
            dataUnitDuration: 1,
            patientId: 'X X X X',
            recordingId: 'Cross check',
            recordingStartTime: new Date(2024, 2, 2, 9, 30, 0),
            signalCount: 1,
            signals: [{
                label: 'EEG Fp1',
                modality: 'eeg',
                name: 'Fp1',
                physicalUnit: '',
                prefiltering: { highpass: null, lowpass: null, notch: null },
                sampleCount: RECORDS*RATE,
                samplingRate: RATE,
                sensitivity: 0,
                sensor: '',
            }],
        } as never)
        encoder.amplitudeRanges.set(0, physical)
        encoder.setSignals([Float32Array.from(samples)])
        const encoded = (await encoder.encode()) as ArrayBuffer
        // The digital samples the encoder would have written, so the builder writes the same file.
        const step = (physical[1] - physical[0])/65535
        const digital = samples.map(value => Math.round((value - physical[0])/step) - 32768)
        const built = buildEdf({
            patientId: 'X X X X',
            recordingId: 'Cross check',
            signals: [{
                digital: [-32768, 32767],
                label: 'EEG Fp1',
                physical,
                records: Array.from({ length: RECORDS }, (_r, r) => digital.slice(r*RATE, (r + 1)*RATE)),
                unit: '',
            }],
        })
        expect(built.byteLength).toBe(encoded.byteLength)
        expect(new Uint8Array(built)).toEqual(new Uint8Array(encoded))
    })
})
