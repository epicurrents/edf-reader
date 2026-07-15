/**
 * Epicurrents EDF exporter. Produces an anonymized EDF file plus a metadata sidecar from a decoded biosignal
 * resource, allowing any importable format to be converted into anonymized EDF.
 * @package    epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericStudyExporter } from '@epicurrents/core'
import type {
    BiosignalHeaderRecord,
    BiosignalResource,
    FileFormatExporter,
    MediaDataset,
} from '@epicurrents/core/dist/types'
import { encodePayload, type EdfEncodePayload } from './encodePayload'
import { extractSignalModality } from '#util'
import type { EdfRecordingType } from '#types'
import { Log } from 'scoped-event-log'

const SCOPE = 'EdfExporter'

/**
 * Options controlling an EDF export.
 */
export type EdfExportOptions = {
    /** Anonymize the EDF file: blank subject identifiers in the header and strip event/label text. Defaults to true. */
    anonymize?: boolean
    /** Anonymize the metadata sidecar as well. Defaults to false, so the sidecar preserves the original metadata. */
    anonymizeSidecar?: boolean
}

/**
 * Result of an EDF export.
 */
export type EdfExportResult = {
    /** The encoded EDF file bytes. */
    edf: ArrayBuffer
    /** The metadata sidecar as a JSON string. */
    sidecar: string
}

export default class EdfExporter extends GenericStudyExporter implements FileFormatExporter {
    /** Monotonic counter for correlating worker encode requests with their responses. */
    protected _commissionCount = 0
    /** Optional factory for an encode worker; when set, encoding runs off the main thread. */
    protected _getWorker: (() => Worker | null) | null = null

    constructor () {
        super('EdfExporter', 'edf', 'Exports a recording as an anonymized EDF file with a metadata sidecar.')
    }

    /** Run the pure encode step, off the main thread when an encode worker is available. */
    protected async _encode (payload: EdfEncodePayload): Promise<EdfExportResult | null> {
        const worker = this._getWorker?.() || null
        if (!worker) {
            return encodePayload(payload)
        }
        return this._encodeViaWorker(worker, payload)
    }

    /** Post the encode payload to a worker and await the encoded result. */
    protected _encodeViaWorker (worker: Worker, payload: EdfEncodePayload): Promise<EdfExportResult | null> {
        return new Promise(resolve => {
            const rn = `${this.id}:${++this._commissionCount}`
            const handler = (event: MessageEvent) => {
                const data = event.data as {
                    rn?: string
                    success?: boolean
                    edf?: ArrayBuffer
                    sidecar?: string
                    error?: string
                }
                if (data?.rn !== rn) {
                    return
                }
                worker.removeEventListener('message', handler)
                if (data.success && data.edf !== undefined && data.sidecar !== undefined) {
                    resolve({ edf: data.edf, sidecar: data.sidecar })
                } else {
                    Log.error(`EDF worker encoding failed: ${data.error || 'unknown error'}.`, SCOPE)
                    resolve(null)
                }
            }
            worker.addEventListener('message', handler)
            // Transfer the (distinct) signal buffers so the potentially large signal data is not copied.
            const transfer = [...new Set(payload.signals.map(signal => signal.buffer))]
            worker.postMessage({ action: 'encode', rn, payload }, transfer)
        })
    }

    /** Resolve the currently active biosignal resource from the application runtime, or null if none is available. */
    protected _getActiveResource (): BiosignalResource | null {
        const runtime = (window as unknown as {
            __EPICURRENTS__?: { RUNTIME?: { APP?: { activeDataset?: { activeResources?: unknown[] } } } }
        }).__EPICURRENTS__?.RUNTIME
        const resources = runtime?.APP?.activeDataset?.activeResources || []
        const resource = resources.find(
            r => typeof (r as { getAllRawSignals?: unknown }).getAllRawSignals === 'function'
        )
        return (resource as BiosignalResource) || null
    }

    /** Trigger a browser download of the given data on the main thread. */
    protected _download (data: BlobPart, fileName: string, mimeType: string) {
        const blob = new Blob([data], { type: mimeType })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = fileName
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(url)
    }

    /**
     * Gather a serializable encode payload from the given resource: physical signals (in base units) plus the metadata
     * the encoder needs. This is the resource- and runtime-dependent half of the export; the payload it produces can be
     * encoded on the main thread or handed to a worker.
     * @param resource - The decoded biosignal resource to read.
     * @param options - Export options.
     * @returns The encode payload, or null if the resource could not be read.
     */
    protected async _gatherPayload (
        resource: BiosignalResource,
        options: EdfExportOptions
    ): Promise<EdfEncodePayload | null> {
        if (!resource.channels.length) {
            Log.error(`Cannot export resource with no channels.`, SCOPE)
            return null
        }
        // Only real signal channels are exported. Meta channels (the EDF Annotations channel, unitless channels)
        // carry no numeric signal and are excluded. Their original index is kept because `getAllRawSignals` returns
        // signals aligned with the full channel list.
        const signalChannels = resource.channels
            .map((channel, index) => ({ channel, index }))
            .filter(({ channel }) => channel.modality !== 'meta' && (channel.samplingRate || 0) > 0)
        if (!signalChannels.length) {
            Log.error(`Cannot export resource: it has no encodable signal channels.`, SCOPE)
            return null
        }
        // Bound the amount of data to request by the shortest whole-second span across the signal channels.
        let maxSeconds = Number.POSITIVE_INFINITY
        for (const { channel } of signalChannels) {
            maxSeconds = Math.min(maxSeconds, Math.floor(channel.sampleCount/channel.samplingRate))
        }
        if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
            Log.error(`Cannot determine a valid recording length for export.`, SCOPE)
            return null
        }
        // Fetch signals from the service only if some channel does not already hold its full cached signal.
        const needsFetch = signalChannels.some(({ channel }) => !channel.signal?.length)
        const fetched = needsFetch ? await resource.getAllRawSignals([0, maxSeconds]) : null
        const payloadChannels: EdfEncodePayload['channels'] = []
        const signals: Float32Array[] = []
        // Determine the record count as the largest whole second every signal channel actually covers.
        let recordCount = Number.POSITIVE_INFINITY
        for (const { channel, index } of signalChannels) {
            const source = channel.signal?.length ? channel.signal : fetched?.signals[index]?.data
            if (!source?.length) {
                Log.error(`Missing signal data for channel ${index} (${channel.label}).`, SCOPE)
                return null
            }
            signals.push(source instanceof Float32Array ? source : Float32Array.from(source))
            recordCount = Math.min(recordCount, Math.floor(source.length/channel.samplingRate))
            payloadChannels.push({
                highpassFilter: channel.highpassFilter,
                label: channel.label,
                lowpassFilter: channel.lowpassFilter,
                // The source channel modality is generic ('signal'); derive the real type from the label (e.g. an
                // "EEG C3" label yields 'eeg'), falling back to the recording modality then the channel's own value.
                modality: extractSignalModality({ label: channel.label })
                          || resource.modality
                          || channel.modality,
                name: channel.name,
                notchFilter: channel.notchFilter,
                sampleCount: channel.sampleCount,
                samplingRate: channel.samplingRate,
                sensitivity: channel.sensitivity,
                unit: channel.unit,
            })
        }
        if (!Number.isFinite(recordCount) || recordCount <= 0) {
            Log.error(`Cannot export resource: no full data records available.`, SCOPE)
            return null
        }
        // Subject identifiers come from the original study header (blanked later if the file is anonymized).
        const sourceHeader = resource.source?.meta?.header as Partial<BiosignalHeaderRecord> | undefined
        const startTime = sourceHeader?.recordingStartTime ?? resource.startTime ?? null
        return {
            anonymize: options.anonymize ?? true,
            anonymizeSidecar: options.anonymizeSidecar ?? false,
            channels: payloadChannels,
            events: resource.events,
            labels: resource.labels,
            interruptions: resource.interruptions.map(({ start, duration }): [number, number] => [start, duration]),
            modality: (resource.modality || 'eeg') as EdfRecordingType,
            recordCount,
            signals,
            subject: {
                patientId: sourceHeader?.patientId ?? null,
                recordingId: sourceHeader?.recordingId ?? null,
                recordingStartTime: startTime ? startTime.toISOString() : null,
            },
        }
    }

    /**
     * Encode the given resource into an anonymized EDF file and a metadata sidecar. This is the format-agnostic core
     * of the exporter: it reads physical signals and metadata from the decoded resource, so it works regardless of the
     * source file format. The encoding step itself is delegated to {@link encodePayload}, which can also run in a
     * worker.
     * @param resource - The decoded biosignal resource to encode.
     * @param options - Export options.
     * @returns The EDF bytes and sidecar JSON, or null if encoding failed.
     */
    async encodeResource (resource: BiosignalResource, options: EdfExportOptions = {}): Promise<EdfExportResult | null> {
        const payload = await this._gatherPayload(resource, options)
        if (!payload) {
            return null
        }
        return this._encode(payload)
    }

    /**
     * Provide a factory for an encode worker. When set, the heavy encoding step runs off the main thread and the
     * finished EDF bytes are transferred back for download. Pass null to encode on the main thread.
     * @param getWorker - Factory returning a worker (or null to disable).
     */
    setWorkerOverride (getWorker: (() => Worker | null) | null) {
        this._getWorker = getWorker
    }

    async exportStudyToDataset (_dataset: MediaDataset, _path: string): Promise<void> {
        // Batch export to a dataset (with optional embedded footer) is a later addition.
        Log.error(`Exporting an EDF study directly to a dataset is not yet supported.`, SCOPE)
    }

    /**
     * Encode the currently active biosignal resource without downloading anything. The host can use this to control
     * the download flow (e.g. download the EDF first, then prompt for the sidecar).
     * @param options - Export options.
     * @returns The EDF bytes, the sidecar JSON, and a suggested base file name, or null if there is nothing to export.
     */
    async exportActiveResource (options: EdfExportOptions = {}): Promise<(EdfExportResult & { fileName: string }) | null> {
        const resource = this._getActiveResource()
        if (!resource) {
            Log.error(`No active biosignal resource is available to export.`, SCOPE)
            return null
        }
        const result = await this.encodeResource(resource, options)
        if (!result) {
            return null
        }
        return { ...result, fileName: (resource.name || 'recording').replace(/\.[^.]+$/, '') }
    }

    /**
     * Export the active biosignal resource as an anonymized EDF file, and download the metadata sidecar alongside it.
     * A one-shot download of both artifacts; hosts that want a staged flow should use {@link exportActiveResource}.
     * @param options - Export options.
     */
    async exportStudyToFileSystem (options: EdfExportOptions = {}): Promise<void> {
        const result = await this.exportActiveResource(options)
        if (!result) {
            return
        }
        this._download(result.edf, `${result.fileName}.edf`, 'application/octet-stream')
        this._download(result.sidecar, `${result.fileName}.edf.json`, 'application/json')
    }
}
