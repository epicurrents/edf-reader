/**
 * Epicurrents EDF recording worker; unloading that work from the main thread since 2021!
 * Seriously though, loading and parsing an EDF file is quite slow and can block the main thread for several seconds,
 * even on more powerful desktops.
 * Signal data is cached in a shared array buffer, because cloning large amounts of data between the main thread and
 * this web worker can lead to serious memory leaks if the garbage collector cannot keep up.
 *
 * The commissions a signal reader answers alike come from {@link SignalReaderWorker}; what is added
 * here is `setup-worker`, the annotations and interruptions an EDF discovers while decoding, and
 * the network-breaker handling that goes with reading a study over the wire.
 * @package    epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import { SETTINGS } from '@epicurrents/core'
import { SignalReaderWorker } from '@epicurrents/core/workers'
import type {
    AppSettings,
    BiosignalHeaderRecord,
    WorkerMessage,
} from '@epicurrents/core/types'
import EdfReader from '#edf/EdfReader'
import type { EdfHeader } from '#types'
import { Log } from 'scoped-event-log'
import { networkBreakers, setNetworkStatusHandler } from '@epicurrents/core/util'

const SCOPE = 'EdfWorker'

class EdfWorker extends SignalReaderWorker<EdfReader> {
    constructor () {
        super(new EdfReader(SETTINGS))
        this._reader.setUpdateCallback((update: { [prop: string]: unknown }) => {
            if (update.action === 'cache-signals') {
                postMessage(update)
            }
        })
        // The action map is bound at dispatch by `handleMessage`, so an entry added unbound here
        // still runs with this worker as its `this`.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        this.extendActionMap([['setup-worker', this.setupWorker]])
    }

    /**
     * An EDF carries its annotations inside the signal stream and its interruptions in the record
     * timing, so both are discovered while decoding and reported with the range they fall in.
     * @param range - Range the signals were read for, in seconds of recording time.
     */
    protected override _signalResponseExtras (range: number[]) {
        return {
            annotations: this._reader.getEvents(range),
            interruptions: this._reader.getInterruptions(range),
        }
    }

    /**
     * Clear this worker's breakers so the next block load is attempted afresh.
     * @param msgData - Data property from the message to the worker.
     */
    override resetNetwork (msgData: WorkerMessage['data']) {
        networkBreakers.reset(msgData.origin as string | undefined)
        return Promise.resolve(true)
    }

    /**
     * Open the study the commission describes.
     * @param msgData - Data property from the message to the worker.
     */
    async setupWorker (msgData: WorkerMessage['data']) {
        const data = this._validate(
            msgData as WorkerMessage['data'] & {
                formatHeader: EdfHeader
                header: BiosignalHeaderRecord
                url?: string
                authHeader?: string
                file?: File
                settingsApp?: Partial<AppSettings['app']>
            },
            {
                formatHeader: 'Object',
                header: 'Object',
                // A local study is read from the File and a remote one from the URL, so neither can
                // be required on its own; `setupStudy` rejects a source that has neither.
                url: 'String?',
                authHeader: 'String?',
                file: 'File?',
                settingsApp: 'Object?',
            }
        )
        if (!data) {
            // The commission is already answered: `_validate` reports the property it refused on
            // through the same transport as any other reply. Answering again here would post a
            // second response with the same request number, which the service has no commission
            // left to match it to.
            return false
        }
        // Apply the main-thread snapshot of app settings before any work that depends on them runs.
        // `_buildDataBlocks` in particular reads `maxLoadCacheSize` and `dataBlockDuration` from
        // `SETTINGS.app` to decide whether to use the rolling-window cache; if those still hold the
        // bundled defaults instead of the user's configuration, the worker's decision diverges from
        // the main thread's.
        if (data.settingsApp) {
            Object.assign(SETTINGS.app, data.settingsApp)
        }
        try {
            const success = await this._reader.setupStudy(
                { authHeader: data.authHeader, file: data.file, url: data.url },
                data.header,
                data.formatHeader
            )
            if (!success) {
                return this._failure(msgData, `Setting up study failed.`)
            }
            return this._success(msgData, {
                dataLength: this._reader.dataLength,
                recordingLength: this._reader.totalLength,
            })
        } catch (e: unknown) {
            return this._failure(msgData, `Setting up study failed: ${(e as Error).message}.`)
        }
    }
}

const WORKER = new EdfWorker()

// Report every per-origin breaker transition to whoever commissioned this worker, so a consumer
// tracking reachability learns of one without polling.
setNetworkStatusHandler((origin, state) => postMessage({ action: 'network-status', origin, state }))

onmessage = async (message: WorkerMessage) => {
    if (!message?.data?.action) {
        return
    }
    Log.debug(`Received message with action ${message.data.action}.`, SCOPE)
    await WORKER.handleMessage(message)
}
