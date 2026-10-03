/**
 * Epicurrents EDF worker tests.
 *
 * The worker module installs itself as the thread's message handler on import, so the cases drive
 * it the way the thread does: a stubbed `postMessage` collects the replies and `onmessage` is the
 * entry point. The reader underneath is the real one, reading a file this suite encodes, since what
 * is tested here is the commission layer the worker adds on top of {@link SignalReaderWorker} —
 * opening a study, and refusing one it cannot.
 * @package    epicurrents/edf-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GenericBiosignalHeader, SETTINGS } from '@epicurrents/core'
import type { WorkerMessage } from '@epicurrents/core/types'
import EdfEncoder from '../src/edf/EdfEncoder'
import EdfImporter from '../src/edf/EdfImporter'

const RECORDS = 10

/** Encode a one-channel EDF the reader can actually open. */
async function encodedFile (): Promise<File> {
    const encoder = new EdfEncoder('eeg')
    encoder.setHeader({
        patientId: 'Worker Subject',
        recordingId: 'Worker Recording',
        recordingStartTime: new Date('2024-03-02T09:30:00.000Z'),
        dataUnitCount: RECORDS,
        dataUnitDuration: 1,
        signalCount: 1,
        signals: [{
            label: 'EEG Fp1',
            name: 'Fp1',
            modality: 'eeg',
            physicalUnit: 'uV',
            prefiltering: { highpass: null, lowpass: null, notch: null },
            sampleCount: 256*RECORDS,
            samplingRate: 256,
            sensitivity: 0,
            sensor: '',
        }],
    } as never)
    encoder.amplitudeRanges.set(0, [-100, 100])
    encoder.setSignals([new Float32Array(256*RECORDS)])
    return new File([(await encoder.encode()) as ArrayBuffer], 'worker.edf')
}

/** The two header objects a `setup-worker` commission has to carry, read from a real file. */
async function studySource () {
    const file = await encodedFile()
    const importer = new EdfImporter()
    expect(await importer.importFile(file)).toBeTruthy()
    const meta = (importer as unknown as { _study: { meta: Record<string, unknown> } })._study.meta
    return {
        file,
        formatHeader: meta.formatHeader,
        header: (meta.header as GenericBiosignalHeader).serializable,
    }
}

let replies: WorkerMessage['data'][]
let serial = 0

/** Send a commission through the thread's handler and collect what it posts back. */
const commission = async (message: Record<string, unknown>) => {
    replies = []
    const handler = (globalThis as unknown as {
        onmessage: ((message: WorkerMessage) => Promise<void>) | null
    }).onmessage
    await handler?.({ data: { rn: ++serial, ...message } } as WorkerMessage)
    return replies
}

describe('EdfWorker', () => {
    beforeAll(() => {
        ;(window as unknown as { __EPICURRENTS__: unknown }).__EPICURRENTS__ = { RUNTIME: { SETTINGS } }
        globalThis.URL.createObjectURL = () => 'blob:worker'
    })

    beforeEach(async () => {
        vi.stubGlobal('postMessage', (message: WorkerMessage['data']) => {
            replies.push(message)
        })
        replies = []
        // Imported after the stub is in place, since the module registers its handler on import.
        await import('../src/workers/edf.worker')
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    describe('message handling', () => {
        it('ignores a message carrying no action', async () => {
            expect(await commission({})).toStrictEqual([])
        })

        it('answers an action it does not know with a failure', async () => {
            const answered = await commission({ action: 'not-an-action' })
            expect(answered[0]?.success).toBe(false)
        })
    })

    describe('setup-worker', () => {
        it('opens a study from a file and reports its length', async () => {
            const answered = await commission({ action: 'setup-worker', ...await studySource() })
            expect(answered[0]).toMatchObject({ recordingLength: RECORDS, success: true })
        })

        it('reports a failure when a property is of the wrong type', async () => {
            const answered = await commission({
                action: 'setup-worker',
                ...await studySource(),
                url: 42,
            })
            expect(answered[0]?.success).toBe(false)
            // Exactly one reply. The validator answers the commission itself, so a handler that
            // also reported the refusal would post a second response carrying the same request
            // number, and the service releases the commission on the first one.
            expect(answered).toHaveLength(1)
        })

        it('reports a failure when the commission names no source', async () => {
            // Neither `file` nor `url` can be required on its own, so this refusal comes from the
            // reader rather than from the validator — and still has to reach the caller.
            const { formatHeader, header } = await studySource()
            const answered = await commission({ action: 'setup-worker', formatHeader, header })
            expect(answered[0]?.success).toBe(false)
            expect(answered).toHaveLength(1)
        })
    })
})
