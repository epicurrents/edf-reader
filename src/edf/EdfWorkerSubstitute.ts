/**
 * EpiCurrents EDF worker substitute. Allows using the EDF loader in the main thread without an actual worker.
 * @package    @epicurrents/edf-file-loader
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import EdfFileReader from './EdfFileReader'
import { ServiceWorkerSubstitute } from '@epicurrents/core'
import { validateCommissionProps } from '@epicurrents/core/dist/util'
import { type ConfigChannelFilter } from '@epicurrents/core/dist/types'
import { Log } from 'scoped-ts-log'

const SCOPE = 'EdfWorkerSubstitute'

export default class EdfWorkerSubstitute extends ServiceWorkerSubstitute {
    protected _reader = new EdfFileReader()
    constructor () {
        super()
        const updateCallback = (update: { [prop: string]: unknown }) => {
            if (update.action === 'cache-signals') {
                this.returnMessage(update)
            }
        }
        this._reader.setUpdateCallback(updateCallback)
    }
    postMessage (message: any) {
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
                message,
                {
                    config: 'Object',
                    range: ['Number', 'Number'],
                },
                true,
                this.returnMessage.bind(this)
            )
            if (!data) {
                return
            }
            const range = data.range as number[]
            const config = data.config as ConfigChannelFilter
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
                        range: message.range,
                        rn: message.rn,
                    })
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
                message,
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
            // Check EDF header.
            const reserved = data.formatHeader.reserved as string | undefined
            if (!reserved?.startsWith('EDF')) {
                Log.error(`Format-specific header is not an EDF-compatible format.`, SCOPE)
                this.returnMessage({
                    action: action,
                    success: false,
                    rn: message.rn,
                })
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