/**
 * Epicurrents EDF worker substitute. Allows using the EDF loader in the main thread without an actual worker.
 * @package    epicurrents/edf-reader
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import EdfReader from './EdfReader'
import { ServiceWorkerSubstitute } from '@epicurrents/core'
import { validateCommissionProps } from '@epicurrents/core/dist/util'
import {
    type BiosignalHeaderRecord,
    type ConfigChannelFilter,
    type GetSignalsResponse,
    type WorkerMessage,
} from '@epicurrents/core/dist/types'
import { Log } from 'scoped-event-log'
import { type EdfHeader } from '#types'

const SCOPE = 'EdfWorkerSubstitute'

export default class EdfWorkerSubstitute extends ServiceWorkerSubstitute {
    protected _reader: EdfReader
    constructor () {
        super()
        if (!window.__EPICURRENTS__?.RUNTIME) {
            Log.error(`Reference to main application was not found!`, SCOPE)
        }
        this._reader = new EdfReader(window.__EPICURRENTS__.RUNTIME.SETTINGS)
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
        switch (action) {
            case 'cache-signals-from-url': {
                try {
                    const success = await this._reader.cacheSignalsFromUrl()
                    return this.returnSuccess({
                        ...message,
                        complete: success,
                    })
                } catch (e) {
                    Log.error(
                        `An error occurred while trying to cache signals, operation was aborted.`,
                    SCOPE, e as Error)
                    return this.returnFailure(message)
                }
            }
            case 'get-signals': {
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
                        return this.returnSuccess({
                            ...message,
                            annotations: annos,
                            dataGaps: gaps,
                            ...sigs,
                        } as WorkerMessage['data'] & Omit<GetSignalsResponse, 'success'>)
                    } else {
                        return this.returnFailure(message)
                    }
                } catch (e) {
                    Log.error(`Getting signals failed.`, SCOPE, e as Error)
                    return this.returnFailure(message)
                }
            }
            case 'release-cache': {
                this._reader.releaseCache()
                return this.returnSuccess(message)
            }
            case 'setup-cache': {
                // Duration is not a mandatory property.
                const duration = (message.dataDuration as number) || 0
                const cache = this._reader.setupCache(duration)
                return this.returnSuccess({
                    ...message,
                    cacheProperties: cache,
                })
            }
            case 'setup-worker': {
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
                const result = await this._reader.setupStudy(data.header, data.formatHeader, data.url)
                if (result) {
                    return this.returnSuccess({
                        ...message,
                        dataLength: this._reader.dataLength,
                        recordingLength: this._reader.totalLength,
                    })
                } else {
                    return this.returnFailure(message)
                }
            }
            case 'shutdown':
            case 'decommission': {
                await this._reader.destroy()
                this._reader = null as unknown as EdfReader
                super.shutdown()
                return this.returnSuccess(message)
            }
            default: {
                super.postMessage(message)
            }
        }
    }
}
