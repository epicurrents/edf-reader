/**
 * EpiCurrents EDF types.
 * @package    @epicurrents/edf-file-loader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import { BiosignalAnnotation, FileFormatLoader, SafeObject, SignalCachePart } from "@epicurrents/core/dist/types"

export type EdfHeader = SafeObject & {
    dataFormat: string
    dataRecordCount: number
    dataRecordDuration: number
    discontinuous: boolean
    edfPlus: boolean
    headerRecordBytes: number
    localRecordingId: string
    patientId: string
    recordByteSize: number
    recordingDate: null | Date
    reserved: string
    signalCount: number
    signalInfo: EdfSignalInfo[],
}

export type EdfHeaderSignal = SafeObject & {
    label: string
    name: string
    type: string
    samplingRate: number
    amplification: number
    sensitivity: number
    signal: Float32Array
    unit: string
    samplesPerRecord: number
    sampleCount: number
    physicalMin: number
    physicalMax: number
    filter: string
    transducer: string
}

/**
 * Properties as they are recorded in the EDF header.
 */
export type EdfSignalInfo = SafeObject & {
    digitalMaximum: number
    digitalMinimum: number
    digitalOffset: number
    label: string
    physicalMaximum: number
    physicalMinimum: number
    physicalUnit: string
    prefiltering: string
    reserved: string
    sampleCount: number
    transducerType: string
    unitsPerBit: number
}

/**
 * EDF+ files store the associated annotations in the same data records
 * as the actuals signals, which is why they are parsed at the same time.
 */
export interface EdfSignalPart extends SignalCachePart {
    annotations?: BiosignalAnnotation[]
    dataGaps?: Map<Number, number>
}