/**
 * Epicurrents EDF worker substitute tests: the replies it gives on the main thread carry the values a real worker's
 * would, since a page that is not cross-origin isolated opens every EDF through the substitute.
 * @package    epicurrents/edf-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

import { beforeAll, describe, expect, test } from 'vitest'
import { GenericBiosignalHeader, SETTINGS } from '@epicurrents/core'
import EdfEncoder from '../src/edf/EdfEncoder'
import EdfImporter from '../src/edf/EdfImporter'
import EdfWorkerSubstitute from '../src/edf/EdfWorkerSubstitute'

const RECORDS = 10

async function encodedFile (): Promise<File> {
    const encoder = new EdfEncoder('eeg')
    encoder.setHeader({
        patientId: 'Substitute Subject',
        recordingId: 'Substitute Recording',
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
    return new File([(await encoder.encode()) as ArrayBuffer], 'substitute.edf')
}

/** Post `message` to `substitute` and resolve with its reply. */
function reply (substitute: EdfWorkerSubstitute, message: Record<string, unknown>) {
    return new Promise<Record<string, unknown>>((resolve) => {
        substitute.onmessage = (event: { data: Record<string, unknown> }) => resolve(event.data)
        void substitute.postMessage(message as never)
    })
}

describe('EdfWorkerSubstitute', () => {
    beforeAll(() => {
        ;(window as unknown as { __EPICURRENTS__: unknown }).__EPICURRENTS__ = { RUNTIME: { SETTINGS } }
        globalThis.URL.createObjectURL = () => 'blob:substitute'
    })

    test('the setup reply carries the recording and data lengths', async () => {
        const file = await encodedFile()
        const importer = new EdfImporter()
        expect(await importer.importFile(file)).toBeTruthy()
        const meta = (importer as unknown as { _study: { meta: Record<string, unknown> } })._study.meta
        const substitute = new EdfWorkerSubstitute()
        const data = await reply(substitute, {
            action: 'setup-worker',
            rn: 1,
            file,
            formatHeader: meta.formatHeader,
            header: (meta.header as GenericBiosignalHeader).serializable,
        })
        expect(data).toMatchObject({ action: 'setup-worker', rn: 1, success: true })
        expect(data.recordingLength).toBe(RECORDS)
        expect(data.dataLength).toBe(RECORDS)
    })
})
