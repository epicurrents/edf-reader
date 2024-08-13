/**
 * Epicurrents EDF types.
 * @package    epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import {
    type AnnotationTemplate,
    type SafeObject,
    type SignalCachePart,
    type SignalDataGapMap,
} from "@epicurrents/core/dist/types"

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
    type: string
    /** Samples per second. */
    samplingRate: number
    amplification: number
    /** Sensitivity as units per cm. */
    sensitivity: number
    signal: Float32Array
    /** Unit of the signal (e.g. µV). */
    unit: string
    /** Number of samples in each data record. */
    samplesPerRecord: number
    /** Total number of samples in this signal. */
    sampleCount: number
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
 * EDF+ files store the associated annotations in the same data records
 * as the actuals signals, which is why they are parsed at the same time.
 */
export interface EdfSignalPart extends SignalCachePart {
    annotations?: AnnotationTemplate[]
    dataGaps?: SignalDataGapMap
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

export interface FileFormatEncoder {

}