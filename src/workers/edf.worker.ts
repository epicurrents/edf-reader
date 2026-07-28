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
import type {
    AppSettings,
    BiosignalHeaderRecord,
    ConfigChannelFilter,
    SignalRequest,
    WorkerMessage,
} from '@epicurrents/core/dist/types'
import type { BufferRangeMove } from 'asymmetric-io-mutex'
import EdfReader from '#edf/EdfReader'
import type { EdfHeader } from '#types'
import { Log } from 'scoped-event-log'
import { validateCommissionProps } from '@epicurrents/core/dist/util'

const SCOPE = "EdfWorker"

const READER = new EdfReader(SETTINGS)

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
    if (action === 'cache-signals') {
        try {
            const startFrom = typeof (message.data as { startFrom?: number })?.startFrom === 'number'
                ? (message.data as { startFrom?: number }).startFrom
                : 0
            const success = await cacheSignals(startFrom)
            return returnSuccess({ complete: success })
        } catch (e: unknown) {
            Log.error(
                `An error occurred while trying to cache signals, operation was aborted: ${(e as Error).message}.`,
            SCOPE, e as Error)
        }
    } else if (action === 'get-signals') {
        // The direct get-signals should only be encountered when the requested signals have not been cached yet,
        // so whenever raw signals are requested and very rarely in other cases. Thus no need to use a lot of
        // time to optimize this method.
        if (!READER.cacheReady) {
            return returnFailure(`Cannot return signals if signal cache is not yet initialized.`)
        }
        const data = validateCommissionProps(
            message.data as WorkerMessage['data'] & {
                config?: ConfigChannelFilter
                range: number[]
            },
            {
                config: 'Object?',
                range: ['Number', 'Number'],
            }
        )
        if (!data) {
            return
        }
        try {
            const sigs = await getSignals(data.range, data.config)
            const annos = getAnnotations(data.range)
            const interruptions = getInterruptions(data.range)
            if (sigs) {
                return returnSuccess({
                    annotations: annos,
                    interruptions: interruptions,
                    range: message.data.range,
                    ...sigs
                })
            } else {
                return returnFailure(`Reader did not return any signals.`)
            }
        } catch (e: unknown) {
            return returnFailure((e as Error).message)
        }
    } else if (action === 'request-signals') {
        if (!READER.cacheReady) {
            return returnFailure(`Cannot return signals if signal cache is not yet initialized.`)
        }
        const data = validateCommissionProps(
            message.data as WorkerMessage['data'] & {
                config?: ConfigChannelFilter
                range: number[]
                stream?: string
            },
            {
                config: 'Object?',
                range: ['Number', 'Number'],
                stream: 'String?',
            }
        )
        if (!data) {
            return
        }
        // Two-stage response protocol: promises cannot cross postMessage, so a non-terminal
        // state is posted with `final: false` and the terminal state follows (same rn) once the
        // request's ready promise settles. A terminal first state is posted alone.
        const postStage = (result: SignalRequest, final: boolean) => {
            const part = 'part' in result ? result.part : null
            postMessage({
                rn: rn,
                action: action,
                success: true,
                status: result.status,
                final: final,
                ...(part ? { start: part.start, end: part.end, signals: part.signals } : {}),
                ...(result.status === 'error' ? { reason: result.reason } : {}),
            })
        }
        const request = await READER.requestSignals(data.range, data.config, data.stream ?? 'view')
        if (request.status === 'pending' || request.status === 'partial') {
            postStage(request, false)
            postStage(await request.ready, true)
        } else {
            postStage(request, true)
        }
        return
    } else if (action === 'setup-cache') {
        const derivationSlots = (message.data.derivationSlots as unknown[] | undefined) ?? []
        if (message.data.useMemoryManager) {
            const data = validateCommissionProps(
                message.data as WorkerMessage['data'] & {
                    buffer: SharedArrayBuffer
                    range: { start: number }
                },
                {
                    buffer: 'SharedArrayBuffer',
                    range: 'Object',
                }
            )
            if (!data) {
                return
            }
            const exportProps = await READER.setupMutex(
                data.buffer,
                data.range.start,
                derivationSlots as Parameters<typeof READER.setupMutex>[2],
            )
            if (exportProps) {
                // Pass the generated shared buffers back to main thread.
                return returnSuccess({
                    cacheProperties: exportProps,
                })
            } else {
                return returnFailure(`Mutex setup failed.`)
            }
        } else {
            // Duration is not a mandatory property.
            const duration = (message.data.dataDuration as number) || 0
            const success = READER.setupCache(
                duration,
                derivationSlots as Parameters<typeof READER.setupCache>[1],
            )
            if (success) {
                return returnSuccess()
            } else {
                return returnFailure(`Cache setup failed.`)
            }
        }
    } else if (action === 'release-cache') {
        await READER.releaseCache()
        return returnSuccess()
    } else if (action === 'set-buffer-range') {
        // The memory manager has rearranged the shared buffer: reposition the reader's own
        // buffer views to the (possibly moved) allocated range. A failure here means the
        // worker's views no longer match the manager's bookkeeping and must be treated as a
        // hard error by the caller.
        const data = validateCommissionProps(
            message.data as WorkerMessage['data'] & { range?: number[], moves?: BufferRangeMove[] },
            {
                range: 'Array?',
                moves: 'Array?',
            }
        )
        if (!data) {
            return
        }
        if (READER.setBufferRange(data.range, data.moves)) {
            return returnSuccess()
        } else {
            return returnFailure(`Repositioning buffer views failed in the worker.`)
        }
    } else if (action === 'release-signal-arrays') {
        // Level 1 of the three-level cache lifecycle: cancel in-flight caching
        // processes and release the mutex's signal-array views, but keep the
        // mutex layout so it can be cheaply rebound via `initSignalBuffers(...,
        // overwrite=true)` on re-activation.
        await READER.releaseSignalArrays()
        return returnSuccess()
    } else if (action === 'setup-worker') {
        const data = validateCommissionProps(
            message.data as WorkerMessage['data'] & {
                formatHeader: EdfHeader
                header: BiosignalHeaderRecord
                url: string
                authHeader?: string
                settingsApp?: Partial<AppSettings['app']>
            },
            {
                formatHeader: 'Object',
                header: 'Object',
                url: 'String',
                authHeader: 'String?',
                settingsApp: 'Object?',
            }
        )
        if (!data) {
            return returnFailure(`Validating commission props failed.`)
        }
        // Apply the main-thread snapshot of app settings (sent by EegService.setupWorker) before
        // any work that depends on them runs. `_buildDataBlocks` in particular reads
        // `maxLoadCacheSize` and `dataBlockDuration` from `SETTINGS.app` to decide whether to use
        // the rolling-window cache; if those still hold the bundled defaults instead of the user's
        // configuration, the worker's decision diverges from the main thread's.
        if (data.settingsApp) {
            Object.assign(SETTINGS.app, data.settingsApp)
        }
        if (await setupStudy(data.header, data.formatHeader, data.url, data.authHeader)) {
            return returnSuccess({
                dataLength: READER.dataLength,
                recordingLength: READER.totalLength,
            })
        } else {
            return returnFailure(`Setting up study failed.`)
        }
    } else if (action === 'shutdown') {
        await READER.releaseCache()
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
        return returnSuccess()
    }
}

const updateCallback = (update: { [prop: string]: unknown }) => {
    if (update.action === 'cache-signals') {
        postMessage(update)
    }
}
READER.setUpdateCallback(updateCallback)

const getAnnotations = (range: number[]) => {
    // EDF only supports events.
    return READER.getEvents(range)
}

const getInterruptions = (range: number[]) => {
    return READER.getInterruptions(range)
}

const getSignals = (range: number[], config?: ConfigChannelFilter) => {
    return READER.getSignals(range, config)
}

/**
 * Cache raw signals from the file at the preset URL.
 * @param startFrom - Start caching from the given time point (in seconds) - optional.
 * @returns Success (true/false).
 */
const cacheSignals = (startFrom = 0) => {
    return READER.cacheSignals(startFrom)
}

const setupStudy = async (header: BiosignalHeaderRecord, edfHeader: EdfHeader, url: string, authHeader?: string) => {
    return READER.setupStudy(header, edfHeader, url, authHeader)
}
