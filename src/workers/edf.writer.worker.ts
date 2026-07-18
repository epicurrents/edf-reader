/**
 * Epicurrents EDF writer worker. Runs the pure EDF encoding step off the main thread so the UI stays responsive while
 * a large recording is quantized. The finished EDF bytes are transferred back for the main thread to download; a
 * worker cannot trigger a download itself.
 * @package    epicurrents/edf-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { encodePayload, type EdfEncodePayload } from '#edf/encodePayload'
import type { WorkerMessage } from '@epicurrents/core/dist/types'
import { Log } from 'scoped-event-log'

const SCOPE = 'EdfWriterWorker'

onmessage = async (message: WorkerMessage) => {
    if (!message?.data?.action) {
        return
    }
    const { action, rn } = message.data
    if (action !== 'encode') {
        return
    }
    const payload = (message.data as { payload?: EdfEncodePayload }).payload
    if (!payload) {
        postMessage({ rn, action, success: false, error: 'Encode message is missing its payload.' })
        return
    }
    try {
        const result = await encodePayload(payload)
        if (result) {
            // Transfer the EDF buffer back with zero copy; the sidecar is a small string sent by structured clone.
            postMessage({ rn, action, success: true, edf: result.edf, sidecar: result.sidecar }, [result.edf])
        } else {
            postMessage({ rn, action, success: false, error: 'Encoding the EDF file failed.' })
        }
    } catch (e: unknown) {
        Log.error(`Error while encoding EDF in worker: ${(e as Error).message}.`, SCOPE)
        postMessage({ rn, action, success: false, error: (e as Error).message })
    }
}
