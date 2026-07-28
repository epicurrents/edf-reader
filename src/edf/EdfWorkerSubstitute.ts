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
    type SignalRequest,
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
            case 'cache-signals': {
                try {
                    const success = await this._reader.cacheSignals()
                    return this.returnSuccess({
                        ...message,
                        complete: success,
                    })
                } catch (e: unknown) {
                    Log.error(
                        `An error occurred while trying to cache signals, operation was aborted: ${
                            (e as Error).message
                        }.`,
                        SCOPE,
                        e as Error
                    )
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
                        config: 'Object?',
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
                    const events = this._reader.getEvents(data.range)
                    const interruptions = this._reader.getInterruptions(data.range)
                    if (sigs) {
                        return this.returnSuccess({
                            ...message,
                            events,
                            interruptions,
                            ...sigs,
                        } as WorkerMessage['data'] & Omit<GetSignalsResponse, 'success'>)
                    } else {
                        return this.returnFailure(message)
                    }
                } catch (e: unknown) {
                    Log.error(`Getting signals failed: ${(e as Error).message}.`, SCOPE, e as Error)
                    return this.returnFailure(message)
                }
            }
            case 'release-cache': {
                this._reader.releaseCache()
                return this.returnSuccess(message)
            }
            case 'request-signals': {
                const data = validateCommissionProps(
                    message as WorkerMessage['data'] & {
                        config?: ConfigChannelFilter
                        range: number[]
                        stream?: string
                    },
                    {
                        config: 'Object?',
                        range: ['Number', 'Number'],
                        stream: 'String?',
                    },
                    true,
                    this.returnMessage.bind(this)
                )
                if (!data) {
                    return
                }
                // Two-stage response protocol, mirroring the real worker: a non-terminal state is
                // returned with `final: false` and the terminal state follows (same rn) once the
                // request's ready promise settles.
                const postStage = (result: SignalRequest, final: boolean) => {
                    const part = 'part' in result ? result.part : null
                    this.returnSuccess({
                        ...message,
                        status: result.status,
                        final: final,
                        ...(part ? { start: part.start, end: part.end, signals: part.signals } : {}),
                        ...(result.status === 'error' ? { reason: result.reason } : {}),
                    })
                }
                const request = await this._reader.requestSignals(data.range, data.config, data.stream ?? 'view')
                if (request.status === 'pending' || request.status === 'partial') {
                    postStage(request, false)
                    postStage(await request.ready, true)
                } else {
                    postStage(request, true)
                }
                return
            }
            case 'set-interruptions': {
                const data = validateCommissionProps(
                    message as WorkerMessage['data'] & {
                        complete?: boolean
                        interruptions: [number, number][]
                    },
                    {
                        complete: 'Boolean?',
                        interruptions: 'Array',
                    },
                    true,
                    this.returnMessage.bind(this)
                )
                if (!data) {
                    return
                }
                this._reader.setInterruptions(new Map(data.interruptions), data.complete ?? false)
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
                        authHeader?: string
                    },
                    {
                        formatHeader: 'Object',
                        header: 'Object',
                        url: 'String',
                        authHeader: 'String?',
                    },
                    true,
                    this.returnMessage.bind(this)
                )
                if (!data) {
                    return
                }
                const result = await this._reader.setupStudy(data.header, data.formatHeader, data.url, data.authHeader)
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
