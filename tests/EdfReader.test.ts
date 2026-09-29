/**
 * Epicurrents EDF reader tests: opening a study, which is where the recording's extent, its data blocks and its
 * interruptions are decided before a single sample is read.
 * @package    epicurrents/edf-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { beforeAll, describe, expect, test } from 'vitest'
import { SETTINGS } from '@epicurrents/core'
import EdfDecoder from '../src/edf/EdfDecoder'
import EdfReader from '../src/edf/EdfReader'
import { headerToBiosignalHeader } from '../src/util'
import { buildEdf, recordTal, type TestSignal } from './edfFile'
import type { EdfHeader } from '../src/types'

const RATE = 4

const signal = (records: number, overrides: Partial<TestSignal> = {}): TestSignal => ({
    digital: [-32768, 32767],
    label: 'EEG Fp1',
    physical: [-100, 100],
    records: Array.from({ length: records }, () => new Array<number>(RATE).fill(0)),
    unit: 'uV',
    ...overrides,
})

/** Open a study from the given bytes and hand back the reader that opened it. */
async function openStudy (bytes: ArrayBuffer) {
    const header = new EdfDecoder(bytes).decodeHeader() as EdfHeader
    const reader = new EdfReader(SETTINGS)
    const opened = await reader.setupStudy(
        { file: new File([bytes], 'test.edf') },
        headerToBiosignalHeader(header),
        header
    )
    return { header, opened, reader }
}

describe('EdfReader.setupStudy', () => {
    beforeAll(() => {
        globalThis.URL.createObjectURL = () => 'blob:reader'
    })

    test('a continuous recording is as long as its data', async () => {
        const { opened, reader } = await openStudy(buildEdf({ signals: [signal(10)] }))
        expect(opened).toBe(true)
        expect(reader.dataLength).toBe(10)
        expect(reader.totalLength).toBe(10)
    })

    test('a discontinuous recording is as long as its data plus its gaps', async () => {
        // Ten one-second records whose last opens at 24 s: fifteen seconds of gap spread through the file.
        const onsets = [0, 1, 2, 3, 14, 15, 16, 17, 18, 24]
        const { opened, reader } = await openStudy(buildEdf({
            annotations: onsets.map(onset => recordTal(onset)),
            plus: 'D',
            signals: [signal(10)],
        }))
        expect(opened).toBe(true)
        // The data is still ten seconds; the recording ran for twenty-five.
        expect(reader.dataLength).toBe(10)
        expect(reader.totalLength).toBe(25)
    })

    test('a source with neither a file nor a URL is refused', async () => {
        const bytes = buildEdf({ signals: [signal(4)] })
        const header = new EdfDecoder(bytes).decodeHeader() as EdfHeader
        const reader = new EdfReader(SETTINGS)
        expect(await reader.setupStudy({}, headerToBiosignalHeader(header), header)).toBe(false)
    })

    test('the data blocks span the recording end to end without a gap or an overlap', async () => {
        const { header, reader } = await openStudy(buildEdf({ signals: [signal(10)] }))
        const blocks = (reader as unknown as {
            _dataBlocks: { endBytePos: number, endRecord: number, startBytePos: number, startRecord: number }[]
        })._dataBlocks
        expect(blocks.length).toBeGreaterThan(0)
        expect(blocks[0].startRecord).toBe(0)
        expect(blocks[0].startBytePos).toBe(header.headerRecordBytes)
        expect(blocks[blocks.length - 1].endRecord).toBe(10)
        for (let i = 1; i < blocks.length; i++) {
            expect(blocks[i].startRecord).toBe(blocks[i - 1].endRecord)
            expect(blocks[i].startBytePos).toBe(blocks[i - 1].endBytePos)
        }
    })

    test('a signal the loader marked as stored inverted keeps that correction', async () => {
        const bytes = buildEdf({ signals: [signal(4), signal(4, { label: 'EEG Fp2' })] })
        const header = new EdfDecoder(bytes).decodeHeader() as EdfHeader
        const biosignalHeader = headerToBiosignalHeader(header)
        // `cacheEdfInfo` rebuilds the biosignal header from the EDF one, so a correction recorded on the header
        // handed in is lost unless it is carried across.
        biosignalHeader.signals[1].invertPolarity = true
        const reader = new EdfReader(SETTINGS)
        await reader.setupStudy({ file: new File([bytes], 'test.edf') }, biosignalHeader, header)
        const rebuilt = (reader as unknown as { _header: { signals: { invertPolarity?: boolean }[] } })._header
        expect(rebuilt.signals[0].invertPolarity).toBeFalsy()
        expect(rebuilt.signals[1].invertPolarity).toBe(true)
    })

    test('opening a study stops every caching process left running, not every second one', async () => {
        const bytes = buildEdf({ signals: [signal(4)] })
        const header = new EdfDecoder(bytes).decodeHeader() as EdfHeader
        const reader = new EdfReader(SETTINGS)
        const processes = (reader as unknown as { _cacheProcesses: { continue: boolean }[] })._cacheProcesses
        processes.push({ continue: true }, { continue: true }, { continue: true })
        const running = [...processes]
        await reader.setupStudy({ file: new File([bytes], 'test.edf') }, headerToBiosignalHeader(header), header)
        // Splicing inside a forward loop moves the next entry into the index just visited, so a process was left
        // running for every one stopped, reading into a cache the new study is about to replace.
        expect(running.map(process => process.continue)).toEqual([false, false, false])
        expect(processes).toHaveLength(0)
    })

    test('a second setup on a reader that already holds a cache is refused', async () => {
        const bytes = buildEdf({ signals: [signal(4)] })
        const header = new EdfDecoder(bytes).decodeHeader() as EdfHeader
        const reader = new EdfReader(SETTINGS)
        const source = { file: new File([bytes], 'test.edf') }
        expect(await reader.setupStudy(source, headerToBiosignalHeader(header), header)).toBe(true)
        reader.setupCache(4)
        expect(await reader.setupStudy(source, headerToBiosignalHeader(header), header)).toBe(false)
    })
})

describe('EdfReader.cacheEdfInfo', () => {
    test('the byte stride is the record size the header states, so a BDF record is the wider one', () => {
        for (const [format, width] of [['edf', 2], ['bdf', 3]] as const) {
            const bytes = buildEdf({
                format,
                signals: [signal(4, { digital: format === 'bdf' ? [-8388608, 8388607] : [-32768, 32767] })],
            })
            const header = new EdfDecoder(bytes).decodeHeader() as EdfHeader
            const reader = new EdfReader(SETTINGS)
            reader.cacheEdfInfo(header, header.recordByteSize)
            const cached = (reader as unknown as { _dataOffset: number, _dataUnitSize: number })
            expect(cached._dataUnitSize).toBe(RATE*width)
            expect(cached._dataOffset).toBe(header.headerRecordBytes)
        }
    })
})
