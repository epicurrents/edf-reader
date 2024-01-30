/**
 * EpiCurrents EDF pseudo worker. Allows using the EDF loader in the main thread without actual workers.
 * @package    @epicurrents/edf-file-loader
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import { type BiosignalHeaderRecord, type ConfigChannelFilter } from '@epicurrents/core/dist/types'
import EdfFileReader from './EdfFileReader'
import { type EdfHeader } from '../types'
import { Log } from 'scoped-ts-log'

const SCOPE = 'EdfPseudoWorker'

export default class EdfPseudoWorker extends Worker {
    protected _eventListeners = [] as {
        event: string,
        callback: (message: any) => unknown
    }[]
    protected _reader = new EdfFileReader()
    onerror = null
    onmessage = null as ((message: any) => unknown) | null
    onmessageerror = null
    postMessage (message: any) {
        if (!message?.data?.action) {
            return
        }
        const action = message.data.action
        Log.debug(`Received message with action ${action}.`, SCOPE)
        if (action === 'get-signals') {
            // Extract job parameters.
            const range = message.data.range as number[]
            const config = message.data.config as ConfigChannelFilter
            try {
                const sigs = this._reader.getSignals(range, config)
                const annos = this._reader.getAnnotations(range)
                const gaps = this._reader.getDataGaps(range)
                if (sigs) {
                    this.returnMessage({
                        action: action,
                        success: true,
                        signals: sigs,
                        annotations: annos,
                        dataGaps: gaps,
                        range: message.data.range,
                        rn: message.data.rn,
                    })
                } else {
                    this.returnMessage({
                        action: action,
                        success: false,
                        rn: message.data.rn,
                    })
                }
            } catch (e) {
                Log.error(`Getting signals failed.`, SCOPE, e as Error)
                this.returnMessage({
                    action: action,
                    success: false,
                    rn: message.data.rn,
                })
            }
        } else if (action === 'setup-study') {
            // Check EDF header.
            const formatHeader = message.data.formatHeader as EdfHeader | undefined
            if (!formatHeader) {
                Log.error(`Commission is missing a format-specific header.`, SCOPE)
                this.returnMessage({
                    action: action,
                    success: false,
                    rn: message.data.rn,
                })
                return
            }
            const reserved = formatHeader.reserved as string | undefined
            if (!reserved?.startsWith('EDF')) {
                Log.error(`Format-specific header is not an EDF-compatible format.`, SCOPE)
                this.returnMessage({
                    action: action,
                    success: false,
                    rn: message.data.rn,
                })
                return
            }
            const header = message.data.header as BiosignalHeaderRecord | undefined
            if (!header) {
                Log.error(`Commission is missing a generic biosignal header.`, SCOPE)
                this.returnMessage({
                    action: action,
                    success: false,
                    rn: message.data.rn,
                })
                return
            }
            const url = message.data.url as string | undefined
            if (!url) {
                Log.error(`Commission is missing a source URL.`, SCOPE)
                this.returnMessage({
                    action: action,
                    success: false,
                    rn: message.data.rn,
                })
                return
            }
            this._reader.setupStudy(header, formatHeader, url).then(result => {
                if (result) {
                    this.returnMessage({
                        action: action,
                        dataLength: this._reader.dataLength,
                        recordingLength: this._reader.totalLength,
                        success: true,
                        rn: message.data.rn,
                    })
                } else {
                    this.returnMessage({
                        action: action,
                        success: false,
                        rn: message.data.rn,
                    })
                }
            })

        } else {
            Log.warn(`'${action}' is not implemented in pseudo-worker.`, SCOPE)
            this.returnMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
        }
    }
    returnMessage (message: any) {
        for (const listener of this._eventListeners) {
            if (listener.event === 'message') {
                listener.callback(message)
            }
        }
        if (this.onmessage) {
            this.onmessage(message)
        }
    }
    terminate () {
        Log.error(`terminate is not implemented in pseudo-worker.`, SCOPE)
    }
    addEventListener <K extends keyof WorkerEventMap>(
        type: K,
        listener: (this: Worker, ev: WorkerEventMap[K]) => any,
        options?: boolean | AddEventListenerOptions | undefined
    ) {
        Log.error(`addEventListener is not implemented in pseudo-worker.`, SCOPE)
    }
    removeEventListener <K extends keyof WorkerEventMap>(
        type: K,
        listener: (this: Worker, ev: WorkerEventMap[K]) => any,
        options?: boolean | EventListenerOptions | undefined
    ) {
        Log.error(`removeEventListener is not implemented in pseudo-worker.`, SCOPE)
    }
    dispatchEvent (event: Event) {
        Log.error(`dispatchEvent is not implemented in pseudo-worker.`, SCOPE)
        return false
    }
}