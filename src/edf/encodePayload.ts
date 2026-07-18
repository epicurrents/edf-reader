/**
 * Pure EDF encoding step, decoupled from any resource or DOM access so it can run on the main thread or inside a
 * worker. It takes fully serializable inputs (metadata plus base-unit signal arrays) and returns the encoded EDF bytes
 * and metadata sidecar.
 * @package    epicurrents/edf-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { getSignalScale } from '@epicurrents/core/dist/util'
import type {
    AnnotationEventTemplate,
    AnnotationLabelTemplate,
    BiosignalHeaderSignal,
} from '@epicurrents/core/dist/types'
import EdfEncoder from './EdfEncoder'
import type { EdfRecordingType } from '#types'
import { Log } from 'scoped-event-log'

const SCOPE = 'encodePayload'

/**
 * A channel description in an encode payload. Mirrors the fields the encoder needs from a `BiosignalChannel`, without
 * the non-serializable parts.
 */
export type EdfEncodePayloadChannel = {
    highpassFilter: number | null
    label: string
    lowpassFilter: number | null
    modality: string
    name: string
    notchFilter: number | null
    sampleCount: number
    samplingRate: number
    sensitivity: number
    /** Display unit of the channel signal (e.g. 'uV'). */
    unit: string
}

/**
 * Fully serializable input to {@link encodePayload}. The `signals` arrays are transferable, so this can be posted to a
 * worker without copying the (potentially large) signal data.
 */
export type EdfEncodePayload = {
    /** Anonymize the EDF file: blank subject identifiers and strip event/label text. */
    anonymize: boolean
    /** Anonymize the metadata sidecar as well. */
    anonymizeSidecar: boolean
    /** Channel descriptions, index-aligned with `signals`. */
    channels: EdfEncodePayloadChannel[]
    /** Structured events for the recording. */
    events: AnnotationEventTemplate[]
    /** Structured labels for the recording. */
    labels: AnnotationLabelTemplate[]
    /** Recording interruptions as `[start, duration]` pairs in seconds. */
    interruptions: [number, number][]
    /** Recording modality. */
    modality: EdfRecordingType
    /** Number of one-second data records to write. */
    recordCount: number
    /** Per-channel signal data in base units (e.g. volts), index-aligned with `channels`. */
    signals: Float32Array[]
    /** Subject and recording identifiers, with the recording start as an ISO string. */
    subject: {
        patientId: string | null
        recordingId: string | null
        recordingStartTime: string | null
    }
}

/**
 * The output of {@link encodePayload}: the encoded EDF file bytes and the metadata sidecar as a JSON string.
 */
export type EdfEncodeOutput = {
    edf: ArrayBuffer
    sidecar: string
}

/**
 * Encode a serializable payload into an anonymized EDF file plus a metadata sidecar. Pure with respect to the DOM and
 * the application runtime, so it runs identically on the main thread or inside a worker.
 * @param payload - The serializable encode payload.
 * @returns The EDF bytes and sidecar JSON, or null if encoding failed.
 */
export async function encodePayload (payload: EdfEncodePayload): Promise<EdfEncodeOutput | null> {
    if (!payload.channels.length) {
        Log.error(`Cannot encode payload with no channels.`, SCOPE)
        return null
    }
    const encoder = new EdfEncoder(payload.modality)
    const headerSignals: BiosignalHeaderSignal[] = []
    const physicalSignals: Float32Array[] = []
    for (let i = 0; i < payload.channels.length; i++) {
        const channel = payload.channels[i]
        const source = payload.signals[i]
        if (!source) {
            Log.error(`Missing signal data for channel ${i} (${channel.label}).`, SCOPE)
            return null
        }
        // Signals arrive in base units (e.g. volts); convert to the channel's display unit (e.g. µV) so the EDF
        // header's physical range matches its unit and the file round-trips in third-party tools.
        const scale = getSignalScale(channel.unit) || 1
        const inUnit = new Float32Array(source.length)
        let min = Number.POSITIVE_INFINITY
        let max = Number.NEGATIVE_INFINITY
        for (let k = 0; k < source.length; k++) {
            const value = source[k]/scale
            inUnit[k] = value
            if (value < min) {
                min = value
            }
            if (value > max) {
                max = value
            }
        }
        // A flat channel has no representable range; widen it so the value survives quantization.
        if (!(max > min)) {
            max = min + 1
        }
        encoder.amplitudeRanges.set(i, [min, max])
        physicalSignals.push(inUnit)
        headerSignals.push({
            label: channel.label,
            name: channel.name,
            modality: channel.modality,
            physicalUnit: channel.unit,
            prefiltering: {
                highpass: channel.highpassFilter,
                lowpass: channel.lowpassFilter,
                notch: channel.notchFilter,
            },
            sampleCount: channel.sampleCount,
            samplingRate: channel.samplingRate,
            sensitivity: channel.sensitivity,
            sensor: '',
        } as unknown as BiosignalHeaderSignal)
    }
    encoder.setHeader({
        patientId: payload.subject.patientId ?? undefined,
        recordingId: payload.subject.recordingId ?? undefined,
        recordingStartTime: payload.subject.recordingStartTime
            ? new Date(payload.subject.recordingStartTime)
            : null,
        dataUnitCount: payload.recordCount,
        dataUnitDuration: 1,
        signalCount: headerSignals.length,
        signals: headerSignals,
        events: payload.events,
        labels: payload.labels,
    })
    encoder.setSignals(physicalSignals)
    encoder.setInterruptions(new Map(payload.interruptions))
    const edf = await encoder.encode(payload.anonymize)
    if (!edf) {
        Log.error(`Encoding the EDF file failed.`, SCOPE)
        return null
    }
    const sidecar = encoder.buildSidecar({ anonymize: payload.anonymizeSidecar })
    return { edf, sidecar }
}
