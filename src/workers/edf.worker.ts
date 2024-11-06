/**
 * Epicurrents EDF recording worker; unloading that work from the main thread since 2021!
 * Seriously though, loading and parsing an EDF file is quite slow and can block the main thread for several seconds,
 * even on more powerful desktops.
 * Signal data is cached in a shared array buffer, because cloning large amounts of data between the main thread and
 * this web worker can lead to serious memory leaks if the garbage collector cannot keep up.
 * @package    epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import { SETTINGS } from '@epicurrents/core'
import {
    type BiosignalHeaderRecord,
    type ConfigChannelFilter,
    type WorkerMessage,
} from '@epicurrents/core/dist/types'
import EdfProcesser from '../edf/EdfProcesser'
import { type EdfHeader } from '#types'
import { Log } from 'scoped-ts-log'
import { validateCommissionProps } from '@epicurrents/core/dist/util'

const SCOPE = "EdfWorker"

const LOADER = new EdfProcesser(SETTINGS)

onmessage = async (message: WorkerMessage) => {
    if (!message?.data?.action) {
        return
    }
    const { action, rn } = message.data
    /** Return a success response to the service. */
    const returnSuccess = (results?: { [key: string]: unknown }) => {
        postMessage({
            rn: rn,
            action: action,
            success: true,
            ...results
        })
    }
    /** Return a failure response to the service. */
    const returnFailure = (error: string | string[]) => {
        postMessage({
            rn: rn,
            action: action,
            success: false,
            error: error,
        })
    }
    Log.debug(`Received message with action ${action}.`, SCOPE)
    if (action === 'cache-signals-from-url') {
        try {
            cacheSignalsFromUrl()
        } catch (e) {
            Log.error(
                `An error occurred while trying to cache signals, operation was aborted.`,
            SCOPE, e as Error)
        }
    } else if (action === 'get-signals') {
        // The direct get-signals should only be encountered when the requested signals have not been cached yet,
        // so whenever raw signals are requested and very rarely in other cases. Thus no need to use a lot of
        // time to optimize this method.
        if (!LOADER.cacheReady) {
            returnFailure(`Cannot return signals if signal cache is not yet initialized.`)
            return
        }
        // Extract job parameters.
        const range = message.data.range as number[]
        const config = message.data.config as ConfigChannelFilter
        try {
            const sigs = await getSignals(range, config)
            const annos = getAnnotations(range)
            const gaps = getDataGaps(range)
            if (sigs) {
                returnSuccess({
                    annotations: annos,
                    dataGaps: gaps,
                    range: message.data.range,
                    ...sigs
                })
            } else {
                returnFailure(`Reader did not return any signals.`)
            }
        } catch (e) {
            returnFailure(e as string)
        }
    } else if (action === 'setup-cache') {
        // Duration is not a mandatory property.
        const duration = (message.data.dataDuration as number) || 0
        const success = LOADER.setupCache(duration)
        if (success) {
            returnSuccess()
        } else {
            returnFailure(`Setting up signal data cache failed.`)
        }
    } else if (action === 'release-cache') {
        await LOADER.releaseCache()
        returnSuccess()
    } else if (action === 'setup-worker') {
        const data = validateCommissionProps(
            message.data as WorkerMessage['data'] & {
                formatHeader: EdfHeader
                header: BiosignalHeaderRecord
                url: string
            },
            {
                formatHeader: 'Object',
                header: 'Object',
                url: 'String',
            }
        )
        if (!data) {
            returnFailure(`Validating commission props failed.`)
            return
        }
        if (await setupStudy(data.header, data.formatHeader, data.url)) {
            returnSuccess({
                dataLength: LOADER.dataLength,
                recordingLength: LOADER.totalLength,
            })
        } else {
            returnFailure(`Setting up study failed.`)
        }
    } else if (action === 'shutdown') {
        await LOADER.releaseCache()
    } else if (action === 'update-settings') {
        Object.assign(SETTINGS, message.data.settings)
        returnSuccess()
    }
}

const updateCallback = (update: { [prop: string]: unknown }) => {
    if (update.action === 'cache-signals') {
        postMessage(update)
    }
}
LOADER.setUpdateCallback(updateCallback)

const getAnnotations = (range: number[]) => {
    return LOADER.getAnnotations(range)
}

const getDataGaps = (range: number[]) => {
    return LOADER.getDataGaps(range)
}

const getSignals = (range: number[], config?: ConfigChannelFilter) => {
    return LOADER.getSignals(range, config)
}

/**
 * Cache raw signals from the file at the preset URL.
 * @param startFrom - Start caching from the given time point (in seconds) - optional.
 * @returns Success (true/false).
 */
const cacheSignalsFromUrl = (startFrom = 0) => {
    return LOADER.cacheSignalsFromUrl(startFrom)
}

const setupStudy = async (header: BiosignalHeaderRecord, edfHeader: EdfHeader, url: string) => {
    return LOADER.setupStudy(header, edfHeader, url)
}