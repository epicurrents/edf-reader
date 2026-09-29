/**
 * Epicurrents EDF utility tests: the translation from an EDF header into the biosignal header every consumer reads.
 * @package    epicurrents/edf-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { describe, expect, test } from 'vitest'
import EdfDecoder from '../src/edf/EdfDecoder'
import { extractSignalModality, headerToBiosignalHeader, parsePrefiltering } from '../src/util'
import { buildEdf, type TestSignal } from './edfFile'

const signal = (overrides: Partial<TestSignal> = {}): TestSignal => ({
    digital: [-32768, 32767],
    label: 'EEG Fp1',
    physical: [-100, 100],
    records: [[0, 1, 2, 3], [4, 5, 6, 7]],
    unit: 'uV',
    ...overrides,
})

describe('headerToBiosignalHeader', () => {
    test('the recording ID comes from the recording field and the patient ID from the patient field', () => {
        const header = new EdfDecoder(buildEdf({
            patientId: 'Subject 1',
            recordingId: 'Recording 1',
            signals: [signal()],
        })).decodeHeader()
        const biosignal = headerToBiosignalHeader(header!)
        // The two fields are distinct in the format and distinct here: a patient ID copied into the recording ID
        // puts the subject's identification into a field every export and sidecar carries as the recording's own.
        expect(biosignal.recordingId).toBe('Recording 1')
        expect(biosignal.patientId).toBe('Subject 1')
    })

    test('signal properties are stated over the whole recording rather than per record', () => {
        const header = new EdfDecoder(buildEdf({ signals: [signal()] })).decodeHeader()
        const biosignal = headerToBiosignalHeader(header!)
        expect(biosignal.dataUnitCount).toBe(2)
        expect(biosignal.dataUnitSize).toBe(header!.recordByteSize)
        expect(biosignal.signals[0].samplingRate).toBe(4)
        // Four samples per record over two records.
        expect(biosignal.signals[0].sampleCount).toBe(8)
    })
})

describe('parsePrefiltering', () => {
    test('reads the filters the EDF specification suggests writing', () => {
        expect(parsePrefiltering('HP:0.5Hz LP:70Hz N:50Hz')).toMatchObject({
            highpass: 0.5,
            lowpass: 70,
            notch: 50,
        })
    })

    test('an absent filter reads as zero rather than as a wrong number', () => {
        expect(parsePrefiltering('LP:70Hz')).toMatchObject({ highpass: 0, lowpass: 70, notch: 0 })
        expect(parsePrefiltering('')).toMatchObject({ highpass: 0, lowpass: 0, notch: 0 })
        expect(parsePrefiltering('None')).toMatchObject({ highpass: 0, lowpass: 0, notch: 0 })
    })
})

describe('extractSignalModality', () => {
    test('derives the modality from the label', () => {
        expect(extractSignalModality({ label: 'EEG C3' })).toBe('eeg')
        expect(extractSignalModality({ label: 'ECG II' })).toBe('ekg')
        expect(extractSignalModality({ label: 'EOG left' })).toBe('eog')
        expect(extractSignalModality({ label: 'Chin EMG' })).toBe('emg')
    })

    test('an annotation channel is recognised under either format name', () => {
        expect(extractSignalModality({ label: 'EDF Annotations' })).toBe('annotation')
        expect(extractSignalModality({ label: 'BDF Annotations' })).toBe('annotation')
    })

    test('a label saying nothing about modality yields nothing', () => {
        expect(extractSignalModality({ label: 'Body temp' })).toBe('')
    })
})
