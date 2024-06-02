/**
 * Epicurrents EDF worker substitute. Allows using the EDF loader in the main thread without an actual worker.
 * @package    epicurrents/edf-reader
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import EdfProcesser from './EdfProcesser'
import { ServiceWorkerSubstitute } from '@epicurrents/core'
import { validateCommissionProps } from '@epicurrents/core/dist/util'
import {
    type BiosignalHeaderRecord,
    type ConfigChannelFilter,
    type GetSignalsResponse,
    type WorkerMessage,
} from '@epicurrents/core/dist/types'
import { Log } from 'scoped-ts-log'
import { type EdfHeader } from '#types/edf'

const SCOPE = 'EdfWorkerSubstitute'

export default class EdfWorkerSubstitute extends ServiceWorkerSubstitute {
    protected _reader: EdfProcesser
    constructor () {
        super()
        if (!window.__EPICURRENTS__?.RUNTIME) {
            Log.error(`Reference to main application was not found!`, SCOPE)
        }
        this._reader = new EdfProcesser(window.__EPICURRENTS__.RUNTIME.SETTINGS)
        const updateCallback = (update: { [prop: string]: unknown }) => {
            if (update.action === 'cache-signals') {
                this.returnMessage(update as WorkerMessage['data'])
            }
        }
        this._reader.setUpdateCallback(updateCallback)
    }
    async postMessage (message: WorkerMessage['data']) {
        if (!message?.action) {
            return
        }
        const action = message.action
        Log.debug(`Received message with action ${action}.`, SCOPE)
        if (action === 'cache-signals-from-url') {
            try {
                this._reader.cacheSignalsFromUrl()
            } catch (e) {
                Log.error(
                    `An error occurred while trying to cache signals, operation was aborted.`,
                SCOPE, e as Error)
                this.returnMessage({
                    action: action,
                    success: false,
                    rn: message.rn,
                })
            }
        } else if (action === 'get-signals') {
            // Extract job parameters.
            const data = validateCommissionProps(
                message as WorkerMessage['data'] & {
                    config?: ConfigChannelFilter
                    range: number[]
                },
                {
                    config: ['Object', 'undefined'],
                    range: ['Number', 'Number'],
                },
                true,
                this.returnMessage.bind(this)
            )
            if (!data) {
                return
            }
            try {
                const sigs = await this._reader.getSignals(data.range, data.config)
                const annos = this._reader.getAnnotations(data.range)
                const gaps = this._reader.getDataGaps(data.range)
                if (sigs) {
                    this.returnMessage({
                        action: action,
                        success: true,
                        annotations: annos,
                        dataGaps: gaps,
                        range: data.range,
                        rn: message.rn,
                        ...sigs
                    } as WorkerMessage['data'] & GetSignalsResponse)
                } else {
                    this.returnMessage({
                        action: action,
                        success: false,
                        rn: message.rn,
                    })
                }
            } catch (e) {
                Log.error(`Getting signals failed.`, SCOPE, e as Error)
                this.returnMessage({
                    action: action,
                    success: false,
                    rn: message.rn,
                })
            }
        } else if (action === 'setup-cache') {
            const cache = this._reader.setupCache()
            this.returnMessage({
                action: action,
                cacheProperties: cache,
                success: true,
                rn: message.rn,
            })
        } else if (action === 'setup-study') {
            const data = validateCommissionProps(
                message as WorkerMessage['data'] & {
                    formatHeader: EdfHeader
                    header: BiosignalHeaderRecord
                    url: string
                },
                {
                    formatHeader: 'Object',
                    header: 'Object',
                    url: 'String',
                },
                true,
                this.returnMessage.bind(this)
            )
            if (!data) {
                return
            }
            this._reader.setupStudy(data.header, data.formatHeader, data.url).then(result => {
                if (result) {
                    this.returnMessage({
                        action: action,
                        dataLength: this._reader.dataLength,
                        recordingLength: this._reader.totalLength,
                        success: true,
                        rn: message.rn,
                    })
                } else {
                    this.returnMessage({
                        action: action,
                        success: false,
                        rn: message.rn,
                    })
                }
            })

        } else {
            super.postMessage(message)
        }
    }
}