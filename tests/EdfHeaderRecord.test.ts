/**
 * Epicurrents EDF header record tests: the biosignal header a decoded EDF presents itself as.
 * @package    epicurrents/edf-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { describe, expect, test } from 'vitest'
import EdfDecoder from '../src/edf/EdfDecoder'
import EdfHeaderRecord from '../src/edf/EdfHeaderRecord'
import { buildEdf, recordTal, type TestSignal } from './edfFile'
import type { EdfHeader } from '../src/types'

const signal = (overrides: Partial<TestSignal> = {}): TestSignal => ({
    digital: [-32768, 32767],
    label: 'EEG Fp1',
    physical: [-100, 100],
    records: [[0, 1, 2, 3], [4, 5, 6, 7]],
    unit: 'uV',
    ...overrides,
})

const headerOf = (bytes: ArrayBuffer) => new EdfDecoder(bytes).decodeHeader() as EdfHeader

describe('EdfHeaderRecord', () => {
    test('the record size follows the format sample width', () => {
        const edf = headerOf(buildEdf({ signals: [signal()] }))
        const bdf = headerOf(buildEdf({ format: 'bdf', signals: [signal({ digital: [-8388608, 8388607] })] }))
        expect(new EdfHeaderRecord(edf, [], [], [], new Map(), edf.dataFormat).dataUnitSize).toBe(8)
        // Three bytes a sample rather than two, which is the stride a reader seeks the file by.
        expect(new EdfHeaderRecord(bdf, [], [], [], new Map(), bdf.dataFormat).dataUnitSize).toBe(12)
    })

    test('the file type carries one plus sign whichever spelling the caller passes', () => {
        const header = headerOf(buildEdf({ annotations: [recordTal(0), recordTal(1)], plus: 'C', signals: [signal()] }))
        expect(header.dataFormat).toBe('edf+')
        // The decoder hands on the format as the header spells it; a study loader may pass the base type instead.
        expect(new EdfHeaderRecord(header, [], [], [], new Map(), header.dataFormat).fileType).toBe('edf+')
        expect(new EdfHeaderRecord(header, [], [], [], new Map(), 'edf').fileType).toBe('edf+')
    })

    test('a record index past the end of a signal is refused rather than answered with nothing', () => {
        const header = headerOf(buildEdf({ signals: [signal()] }))
        const record = new EdfHeaderRecord(header, [[[0, 1]]], [[[0, 1]]], [], new Map(), 'edf')
        expect(record.getPhysicalSignal(0, 0)).toBeInstanceOf(Float32Array)
        expect(record.getPhysicalSignal(0, 5)).toBeNull()
        expect(record.getPhysicalSignal(0, -1)).toBeNull()
        expect(record.getRawSignal(0, 5)).toBeNull()
        expect(record.getSignalPhysicalMax(5)).toBeNull()
    })

    test('concatenating one record returns that record rather than nothing', () => {
        const header = headerOf(buildEdf({ signals: [signal()] }))
        const record = new EdfHeaderRecord(header, [], [[[1, 2], [3, 4]]], [], new Map(), 'edf')
        expect(Array.from(record.getPhysicalSignalConcatRecords(0, 0, 1)!)).toEqual([1, 2])
        expect(Array.from(record.getPhysicalSignalConcatRecords(0)!)).toEqual([1, 2, 3, 4])
        expect(Array.from(record.getPhysicalSignalConcatRecords(0, 0, 9)!)).toEqual([1, 2, 3, 4])
    })
})
