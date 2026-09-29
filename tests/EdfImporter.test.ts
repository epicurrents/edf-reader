/**
 * Epicurrents EDF importer tests: opening a file, which is what puts the channels and the two headers into the study
 * the EEG module then builds its resource from.
 * @package    epicurrents/edf-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { beforeAll, describe, expect, test } from 'vitest'
import type { GenericBiosignalHeader } from '@epicurrents/core'
import EdfImporter from '../src/edf/EdfImporter'
import { buildEdf, type TestSignal } from './edfFile'
import type { EdfHeader, EdfHeaderSignal } from '../src/types'

const signal = (overrides: Partial<TestSignal> = {}): TestSignal => ({
    digital: [-32768, 32767],
    label: 'EEG Fp1',
    physical: [-100, 100],
    records: [[0, 1, 2, 3], [4, 5, 6, 7]],
    unit: 'uV',
    ...overrides,
})

/** The study an importer has filled, with its meta under the shape this package writes. */
const studyMeta = (importer: EdfImporter) => {
    const study = (importer as unknown as {
        _study: { format: string, modality: string, meta: Record<string, unknown> }
    })._study
    return {
        channels: study.meta.channels as EdfHeaderSignal[],
        format: study.format,
        formatHeader: study.meta.formatHeader as EdfHeader,
        header: study.meta.header as GenericBiosignalHeader,
        modality: study.modality,
    }
}

describe('EdfImporter.readHeader', () => {
    test('returns the parsed EDF header rather than a summary of it', async () => {
        const bytes = buildEdf({ patientId: 'Subject 1', signals: [signal()] })
        const header = await new EdfImporter().readHeader(bytes.slice(0, 256))
        // The signal count is what sizes the second read, and the rest is the header the worker is later handed.
        expect(header?.signalCount).toBe(1)
        expect(header?.dataRecordCount).toBe(2)
        expect(header?.dataRecordDuration).toBe(1)
        expect(header?.headerRecordBytes).toBe(512)
        expect(header?.patientId).toBe('Subject 1')
    })

    test('bytes that are not an EDF header give nothing back', async () => {
        expect(await new EdfImporter().readHeader(new Uint8Array(256).fill(32).buffer)).toBeNull()
    })
})

describe('EdfImporter.importFile', () => {
    beforeAll(() => {
        globalThis.URL.createObjectURL = () => 'blob:importer'
    })

    test('fills the study with the channels and both headers', async () => {
        const importer = new EdfImporter()
        const file = new File([buildEdf({ recordingId: 'Recording 1', signals: [signal()] })], 'test.edf')
        const studyFile = await importer.importFile(file)
        expect(studyFile).toMatchObject({ format: 'edf', modality: 'signal', role: 'data' })
        const meta = studyMeta(importer)
        expect(meta.format).toBe('edf')
        expect(meta.modality).toBe('signal')
        expect(meta.channels).toHaveLength(1)
        expect(meta.channels[0]).toMatchObject({ label: 'EEG Fp1', samplingRate: 4, unit: 'uV' })
        // Eight samples over two records.
        expect(meta.channels[0].sampleCount).toBe(8)
        expect(meta.header.recordingId).toBe('Recording 1')
        expect(meta.formatHeader.signalInfo[0].label).toBe('EEG Fp1')
    })

    test('a channel carrying no numeric signal is marked as meta', async () => {
        const importer = new EdfImporter()
        const file = new File([buildEdf({
            signals: [
                signal(),
                // A channel with no physical unit carries no numeric signal to display.
                signal({ label: 'Marker', unit: '' }),
            ],
        })], 'test.edf')
        await importer.importFile(file)
        const meta = studyMeta(importer)
        expect(meta.channels.map(c => c.modality)).toEqual(['signal', 'meta'])
    })

    test('the annotation channel is meta whichever format names it', async () => {
        for (const format of ['edf', 'bdf'] as const) {
            const importer = new EdfImporter()
            const file = new File([buildEdf({
                annotations: ['+0\x14\x14\x00', '+1\x14\x14\x00'],
                format,
                plus: 'C',
                signals: [signal({ digital: format === 'bdf' ? [-8388608, 8388607] : [-32768, 32767] })],
            })], `test.${format}`)
            await importer.importFile(file)
            const meta = studyMeta(importer)
            expect(meta.channels).toHaveLength(2)
            expect(meta.channels[1].modality).toBe('meta')
        }
    })

    test('the file extension decides the format the study file records', async () => {
        const importer = new EdfImporter()
        const bytes = buildEdf({ format: 'bdf', signals: [signal({ digital: [-8388608, 8388607] })] })
        const studyFile = await importer.importFile(new File([bytes], 'test.bdf'))
        expect(studyFile?.format).toBe('bdf')
    })

    test('a file that is not EDF or BDF is refused', async () => {
        const importer = new EdfImporter()
        const file = new File([new Uint8Array(512).fill(32)], 'test.edf')
        expect(await importer.importFile(file)).toBeNull()
    })
})
