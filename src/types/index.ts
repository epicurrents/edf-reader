/**
 * Epicurrents EDF types.
 * @package    epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import type {
    AnnotationEventTemplate,
    AnnotationLabelTemplate,
    BiosignalChannel,
    ConfigReadHeader,
    ConfigReadSignals,
    SafeObject,
    SignalCachePart,
    SignalInterruptionMap,
} from "@epicurrents/core/dist/types"

/**
 * Types of attachments that can be stored in the EDF footer.
 * These are not time-synced to the recording, but can be used to store additional information about the recording,
 * such as measurements, images, audio files, and other kinds of supplementary information.
 *
 * Attachment types:
 * - audio: Audio files, such as recordings of the patient or the environment.
 * - document: Documents related to the recording, such as reports or notes.
 * - history: Patient history and any events leading to the recording (not allowed in anonymous recordings).
 * - image: Images, such as photographs or screenshots.
 * - measurement: Measurements taken during/before the recording, such as physiological measurements.
 * - other: Other types of attachments that do not fit into the above categories.
 * - status: Patient status findings at the time of the recording (not allowed in anonymous recordings).
 * - video: Video files that are not time-synced to the recording, but are related to it.
 */
export type AttachmentType = "audio" | "document" | "history" | "image" | "measurement" | "other" | "status" | "video"
export type ConfigReadEdfHeader = ConfigReadHeader & Partial<ConfigReadSignals>
/**
 * EDF footer contains metadata about the recording, such as annotations, interruptions, channel properties, and videos.
 * It is an extension to the EDF header. It is meant to be read and parsed after the header and before the signal data.
 */
export type EdfFooter = SafeObject & {
    /** Any file attachments that are not time-synced videos. */
    attachments: {
        /** Byte end position of the attachment. */
        byteEnd: number
        /** Byte start position of the attachment. */
        byteStart: number
        /** Description of the attachment contents. */
        description: string
        /** Attachment file mime type. */
        mimeType: string
        /** Attachment type (e.g. image). */
        type: AttachmentType
        /** File name of the attachment, if not embedded. */
        fileName?: string
        /** Possible recording time position for this attachment (e.g. time of a picture, start time of audio). */
        timePosition?: number
    }[]
    channels: EdfFooterChannel[]
    /**
     * Additional Epicurrents application configuration.
     * This configuration only applies to the appropriate resource module, in this case the EEG module.
     */
    config: SafeObject
    /** Events in the recording. */
    events: AnnotationEventTemplate[]
    /** Interruptions in the recording. */
    interruptions: SignalInterruptionMap
    /** Labels in the recording. */
    labels: AnnotationLabelTemplate[]
    /** Recording modality (in this case "eeg"). */
    modality: "eeg"
    /** Recording date as an ISO string or null if not known. */
    recordingDate: null | string
    /** Footer version. */
    version: string
    /**
     * Number of video feeds (not vide files) associated with this recording.
     * This is usually same as the number of cameras.
     */
    videoCount: number
    /** Videos that are time-synced to the EEG recording. */
    videos: {
        /** Byte end position of the video segment. */
        byteEnd: number
        /** Byte start position of the video segment. */
        byteStart: number
        /** Index of the camera this video is from. */
        cameraIndex: number
        /** Video end time in seconds. */
        endTime: number
        /** Video file format description. */
        format: string
        /** Video mime type (e.g. video/mp4). */
        mimeType: string
        /** Video start time in seconds. */
        startTime: number
        /** Synchronization time points as [recording time, video time] in seconds. */
        syncTimes: [number, number][]
        /** File name of the video, if not embedded. */
        fileName?: string
    }[]
}
/**
 * Channel information as it is stored in the EDF footer.
 */
export type EdfFooterChannel = SafeObject & {
    /** Channel label, e.g. "C3" or "EEG Fp1". */
    label: BiosignalChannel['label']
    /** Channel modality, e.g. "eeg" or "ecg". */
    modality: BiosignalChannel['modality']
    /** Channel name, e.g. "EEG Fp1". */
    name: BiosignalChannel['name']
    /** Minimum value of the channel in physical units, e.g. -5000 (uV) for EEG. */
    physicalMin: number
    /** Maximum value of the channel in physical units, e.g. 5000 (uV) for EEG. */
    physicalMax: number
    /** Channel prefilters. */
    preFilters: BiosignalChannel['filters']
    /** Total number of samples in the channel. */
    sampleCount: number
    /** Channel samples per single record. */
    samplesPerRecord: number
    /** Channel sampling rate in Hz. */
    samplingRate: BiosignalChannel['samplingRate']
    /** Channel amplitude scaling as a power of 10. */
    scale: BiosignalChannel['scale']
    /** Channel sensitivity in units per cm, e.g. 100 (uV/cm) for EEG. */
    sensitivity: BiosignalChannel['sensitivity']
    /** Channel unit, e.g. "µV" for EEG. */
    unit: BiosignalChannel['unit']
}

/**
 * Options controlling how the EDF encoder produces its output.
 */
export type EdfEncodeOptions = {
    /**
     * Embed the sidecar metadata as a JSON footer appended to the EDF file. Defaults to false; the primary export
     * path delivers the sidecar as a separate file via the encoder's `buildSidecar` method instead.
     */
    embedFooter?: boolean
    /**
     * When embedding a footer, anonymize the embedded sidecar as well. Independent of the file-level `anonymize`
     * flag, so an anonymized file may still embed original metadata (or vice versa). Defaults to the `anonymize` value.
     */
    embedFooterAnonymized?: boolean
}

/**
 * Serializable sidecar metadata for an exported EDF recording. It carries the descriptive information that does not
 * fit into (or is stripped from) the EDF header, so it can be delivered as a separate JSON file or optionally embedded
 * as a footer. The sidecar deliberately excludes free-form annotations; only structured events and labels are kept.
 */
export type EdfSidecar = {
    /** Per-channel signal descriptions. */
    channels: EdfFooterChannel[]
    /** Structured events in the recording. */
    events: AnnotationEventTemplate[]
    /** Recording interruptions as `[start, duration]` pairs in seconds. */
    interruptions: [number, number][]
    /** Structured labels for the recording. */
    labels: AnnotationLabelTemplate[]
    /** Recording modality. */
    modality: EdfRecordingType
    /** Subject and recording identifiers, either original or blanked when anonymized. */
    subject: {
        /** Local patient identification field, or null when anonymized. */
        patientId: string | null
        /** Recording start date as an ISO string, or null when unknown or anonymized. */
        recordingDate: string | null
        /** Local recording identification field, or null when anonymized. */
        recordingId: string | null
    }
    /** Sidecar schema version. */
    version: string
}

export type EdfHeader = SafeObject & {
    dataFormat: string
    /** Number of data records in the recording. */
    dataRecordCount: number
    /** Duration of each data record in seconds. */
    dataRecordDuration: number
    /** Is the source signal discontinous. */
    discontinuous: boolean
    /** How many bytes are occupied by the header record at the beginning of the file. */
    headerRecordBytes: number
    isPlus: boolean
    localRecordingId: string
    patientId: string
    /** Number of bytes per data record. */
    recordByteSize: number
    recordingDate: null | Date
    reserved: string
    /** Number of signals in the file. */
    signalCount: number
    /** EDF-specific signal information parsed from the header record. */
    signalInfo: EdfSignalInfo[],
}

export type EdfHeaderSignal = SafeObject & {
    label: string
    name: string
    modality: string
    /** Samples per second. */
    samplingRate: number
    /** Sensitivity as units per cm. */
    sensitivity: number
    signal: Float32Array
    /** Unit of the signal (e.g. µV). */
    unit: string
    /** Number of samples in each data record. */
    samplesPerRecord: number
    /** Total number of samples in this signal. */
    sampleCount: number
    /** Amplitude scaling as a power of 10. */
    scale: number
    /** Minimum value of the signal in physical units. */
    physicalMin: number
    /** Maximum value of the signal in physical units. */
    physicalMax: number
    filter: string
    transducer: string
}

/**
 * Types of recordings that can be encoded with the EdfEncoder.
 */
export type EdfRecordingType = "eeg"

/**
 * Properties as they are recorded in the EDF header.
 */
export type EdfSignalInfo = SafeObject & {
    /** Maximum value of the digital signal (depends on sample bit depth). */
    digitalMaximum: number
    /** Minimum value of the digital signal (depends on sample bit depth). */
    digitalMinimum: number
    /** Offset from baseline of the digital signal. */
    digitalOffset: number
    label: string
    /** Maximum value of the converted physical signal. */
    physicalMaximum: number
    /** Minimum value of the converted physical signal. */
    physicalMinimum: number
    /** Unit of the physical signal (e.g. µV). */
    physicalUnit: string
    /** Filtering that has been applied to the source signal (e.g. "HP:0.1Hz LP:75Hz N:50Hz") */
    prefiltering: string
    reserved: string
    /** Number of samples per data record. */
    sampleCount: number
    transducerType: string
    /**
     * Number of units that a single bit of the digital signal represents in the physical signal.
     * This is essentially the maximum resolution of the source signal.
     */
    unitsPerBit: number
}

/**
 * EDF+ files store the associated events in the same data records as the actual signals, which is why they are parsed
 * at the same time.
 */
export interface EdfSignalPart extends SignalCachePart {
    events?: AnnotationEventTemplate[]
    interruptions?: SignalInterruptionMap
}

/**
 * Basic properties of a signal needed to encode it into EDF.
 */
export type EdfSignalProperties = {
    /** Actual signal data as Float32Array. */
    data: Float32Array
    /** Signal offset from baseline in units. */
    offsetFromBaseline: number
    /** Signal samples per second. */
    samplingRate: number
    /** Physical unit of the signal. */
    unit: string
    /**
     * How many uVs should a single digit (bit) of Int16 represent.
     * This is the minimum resolution of the signal that is decoded from the EDF recording.
     */
    uVperInt16: number
}
