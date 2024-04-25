/**
 * EpiCurrents EDF recording worker; unloading that work from the main thread since 2021!
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
import { type EdfHeader } from '#types/edf'
import { Log } from 'scoped-ts-log'
import { validateCommissionProps } from '@epicurrents/core/dist/util'

const SCOPE = "EdfWorkerSAB"

const LOADER = new EdfProcesser(SETTINGS)

onmessage = async (message: WorkerMessage) => {
    if (!message?.data?.action) {
        return
    }
    const action = message.data.action
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
            Log.error(`Cannot return signals if signal cache is not yet initialized.`, SCOPE)
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
            return
        }
        const data = validateCommissionProps(
            message.data,
            {
                config: ['Object', 'undefined'],
                range: ['Number', 'Number'],
            }
        )
        if (!data) {
            return
        }
        try {
            const sigs = await getSignals(data.range, data.config)
            const annos = getAnnotations(data.range)
            const gaps = getDataGaps(data.range)
            if (sigs) {
                postMessage({
                    action: action,
                    success: true,
                    signals: sigs,
                    annotations: annos,
                    dataGaps: gaps,
                    range: message.data.range,
                    rn: message.data.rn,
                })
            } else {
                postMessage({
                    action: action,
                    success: false,
                    rn: message.data.rn,
                })
            }
        } catch (e) {
            Log.error(`Getting signals failed.`, SCOPE, e as Error)
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
        }
    } else if (action === 'setup-cache') {
        const data = validateCommissionProps(
            message.data,
            {
                buffer: 'SharedArrayBuffer',
                range: 'Object',
            }
        )
        if (!data) {
            return
        }
        const exportProps = await LOADER.setupMutex(data.buffer, data.range.start)
        console.warn(exportProps)
        if (exportProps) {
            // Pass the generated shared buffers back to main thread.
            postMessage({
                action: action,
                cacheProperties: exportProps,
                success: true,
                rn: message.data.rn,
            })
        } else {
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
        }
    } else if (action === 'release-cache') {
        await LOADER.releaseCache()
        postMessage({
            action: action,
            success: true,
            rn: message.data.rn,
        })
    } else if (action === 'setup-study') {
        const data = validateCommissionProps(
            message.data,
            {
                formatHeader: 'Object',
                header: 'Object',
                url: 'String',
            }
        )
        if (!data) {
            return
        }
        if (await setupStudy(data.header, data.formatHeader, data.url)) {
            postMessage({
                action: action,
                dataLength: LOADER.dataLength,
                recordingLength: LOADER.totalLength,
                success: true,
                rn: message.data.rn,
            })
        } else {
            postMessage({
                action: action,
                success: false,
                rn: message.data.rn,
            })
        }
    } else if (action === 'shutdown') {
        await LOADER.releaseCache()
    } else if (action === 'update-settings') {
        const data = validateCommissionProps(
            message.data,
            {
                settings: 'Object',
            }
        )
        if (!data) {
            return
        }
        Object.assign(SETTINGS, data.settings)
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