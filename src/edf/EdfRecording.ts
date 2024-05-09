/**
 * EDF recording class to store EDF header information.
 * @package    epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericBiosignalHeader } from '@epicurrents/core'
import {
    type AnnotationTemplate,
    type BiosignalFilters,
    type BiosignalHeaderSignal,
    type SignalDataGapMap,
} from '@epicurrents/core/dist/types'
import { type EdfHeader } from '../types/edf'
import EdfDecoder from './EdfDecoder'
import Log from 'scoped-ts-log'

const SCOPE = 'EdfHeader'

export default class EdfRecording extends GenericBiosignalHeader {
    private _header: EdfHeader
    private _physicalSignals: Float32Array[][]
    private _rawSignals: Int16Array[][]

    constructor (
        header: EdfHeader,
        rawSignals = [] as Int16Array[][],
        physicalSignals = [] as Float32Array[][],
        annotations = [] as AnnotationTemplate[],
        dataGaps = new Map() as SignalDataGapMap,
        fileType = 'edf'
    ) {
        // Calculate record size
        // In case of possible BDF support in the future
        const SampleType = fileType === 'edf' ? Int16Array : Int16Array
        let maxSr = 0
        let dataRecordSize = 0
        const signalProps = [] as BiosignalHeaderSignal[]
        for (const sig of header.signalInfo) {
            dataRecordSize += sig.sampleCount*SampleType.BYTES_PER_ELEMENT
            const sigSr = sig.sampleCount/header.dataRecordDuration
            if (sigSr > maxSr) {
                maxSr = sigSr
            }
            // Try to parse prefiltering field.
            signalProps.push({
                label: sig.label,
                name: sig.label,
                physicalUnit: sig.physicalUnit,
                prefiltering: EdfDecoder.ParsePrefiltering(sig.prefiltering),
                sampleCount: sig.sampleCount,
                samplingRate: sigSr,
                sensitivity: 0,
                type: EdfDecoder.ExtractSignalType(sig),
            } as BiosignalHeaderSignal)
        }
        super(
            header.edfPlus ? 'edf+' : 'edf', header.localRecordingId, header.patientId,
            header.dataRecordCount, header.dataRecordDuration, dataRecordSize,
            header.signalCount, signalProps, header.recordingDate,
            header.discontinuous, annotations, dataGaps
        )
        this._header = header
        this._physicalSignals = physicalSignals
        this._rawSignals = rawSignals
    }

    /**
     * The EDF header record.
     */
    get header () {
        return this._header
    }
    /**
     * Whether this recording is discontinuous.
     */
    get isDiscontinuous () {
        return this._header.discontinuous
    }
    /**
     * Whether this recording uses the EDF+ specification.
     */
    get isEdfPlus () {
        return this._header.edfPlus
    }
    /**
     * Size of the header record in bytes.
     */
    get size () {
        return this._header.headerRecordBytes
    }

    /**
    * Get the physical maximum for a given signal.
    * @param index - Index of the signal.
    * @returns The physical signal max, null if signal index is out of range.
    */
    getSignalPhysicalMax (index: number): number | null {
        if (index < 0 || index >= this._header.signalInfo.length) {
            Log.warn(`Signal index ${index} is out of range, cannot return physical maximum.`, SCOPE)
            return null
        }
        return this._header.signalInfo[index].physicalMaximum
    }

    /**
    * Get the physical minimum for a given signal.
    * @param index - Index of the signal.
    * @returns The physical signal min, null if signal index is out of range.
    */
    getSignalPhysicalMin (index: number): number | null {
        if (index < 0 || index >= this._header.signalInfo.length) {
            Log.warn(`Signal index ${index} is out of range, cannot return physical minimum.`, SCOPE)
            return null
        }
        return this._header.signalInfo[index].physicalMinimum
    }

    /**
    * Get the physical (scaled) signal at a given index and record.
    * @param index - Index of the signal.
    * @param record - Index of the record.
    * @returns The physical signal in Float32, null if signal or record index out of range.
    */
    getPhysicalSignal (index: number, record: number): Float32Array | null {
        if (index < 0 || index >= this._header.signalInfo.length) {
            Log.warn(`Signal index ${index} is out of range, cannot return physical signal.`, SCOPE)
            return null
        }

        if (record < 0 && record>=this._physicalSignals[index].length) {
            Log.warn(`Record index ${record} is out of range, cannot return physical signal.`, SCOPE)
            return null
        }
        return this._physicalSignals[index][record]
    }

    /**
    * Get concatenated contiguous records of a given signal, the index of the first record and the number of records
    * to concat.
    *
    * Notice: this allocates a new buffer of an extented size.
    *
    * @param index - Index of the signal.
    * @param recordStart - Index of the record to start with.
    * @param howMany - Number of records to concatenate.
    * @returns The physical signal in Float32, null if signal or record index out of range.
    */
    getPhysicalSignalConcatRecords (index: number, recordStart=-1, howMany=-1): Float32Array | null {
        if (index < 0 || index >= this._header.signalInfo.length) {
            Log.warn(`Signal index ${index} is out of range, cannot concatenate signal records.`, SCOPE)
            return null
        }
        if (recordStart < 0 && recordStart>=this._physicalSignals[index].length) {
            Log.warn(`Record index ${recordStart} is out of range, cannot concatenate signal records.`, SCOPE)
            return null
        }
        if (recordStart === -1) {
            recordStart = 0
        }
        if (howMany === -1) {
            howMany = this._physicalSignals[index].length - recordStart
        } else {
            // we still want to check if what the user put is not out of bound.
            if (recordStart + howMany > this._physicalSignals[index].length) {
                Log.debug(
                    "The number of requested records to concatenate is too large. Returning only available records.",
                SCOPE)
                howMany = this._physicalSignals[index].length - recordStart
            }
        }
        const recordEnd = recordStart + howMany - 1
        if (recordEnd === recordStart) {
            Log.debug("No more records to concatenate.", SCOPE)
            return new Float32Array()
        }
        let totalSize = 0
        for (let i=recordStart; i<recordStart + howMany; i++) {
            totalSize += this._physicalSignals[index][i].length
        }
        const concatSignal = new Float32Array(totalSize)
        let offset = 0
        for (let i=recordStart; i<recordStart + howMany; i++) {
            concatSignal.set(this._physicalSignals[index][i], offset)
            offset += this._physicalSignals[index][i].length
        }
        return concatSignal
    }

    /**
    * Get the raw (digital) signal at a given index and record.
    * @param index - Index of the signal.
    * @param record - Index of the record.
    * @returnthe The digital signal in Int16, null if signal or record index out of range.
    */
    getRawSignal (index: number, record: number): Int16Array | null {
        if (index < 0 || index >= this._header.signalInfo.length) {
            Log.warn(`Signal index ${index} is out of range, cannot return raw signal.`, SCOPE)
            return null
        }
        if (record < 0 && record>=this._rawSignals[index].length) {
            Log.warn(`Record index ${record} is out of range, cannot return raw signal.`, SCOPE)
            return null
        }
        return this._rawSignals[index][record]
    }

    /**
    * Get the value of the reserved field, global (from header) or specific to a signal.
    * Notice: Reserved are rarely used.
    * @param index - Index of the signal. If not specified, get the header's reserved field.
    * @returns The data in the reserved field.
    */
    getReservedField (index=-1): string | null {
        if (index === -1) {
            return this._header.reserved
        } else {
            if (index >= 0 && index < this._header.signalInfo.length) {
                return this._header.signalInfo[index]?.reserved
            }
        }
        return null
    }

    /**
    * Get the digital maximum for a given signal index.
    * @param index - Index of the signal.
    * @returns The digital signal max, null if signal index is out of range.
    */
    getSignalDigitalMax (index: number): number | null {
        if (index < 0 || index >= this._header.signalInfo.length) {
            Log.warn(`Signal index ${index} is out of range, cannot return digital maximum.`, SCOPE)
            return null
        }
        return this._header.signalInfo[index].digitalMaximum
    }

    /**
    * Get the digital minimum for a given signal index.
    * @param index - Index of the signal.
    * @returns The digital signal min, null if signal index is out of range.
    */
    getSignalDigitalMin (index: number): number | null {
        if (index < 0 || index >= this._header.signalInfo.length) {
            Log.warn(`Signal index ${index} is out of range, cannot return digital minimum.`, SCOPE)
            return null
        }
        return this._header.signalInfo[index].digitalMinimum
    }

    /**
    * Get the unit prefiltering info for a given signal index.
    * @param index - Index of the signal., null if signal index is out of range.
    * @returns The prefiltering info.
    */
    getSignalPrefiltering (index: number): BiosignalFilters | null {
        if (index < 0 || index >= this._header.signalInfo.length) {
            Log.warn(`Signal index ${index} is out of range, cannot return signal prefiltering.`, SCOPE)
            return null
        }
        return EdfDecoder.ParsePrefiltering(this._header.signalInfo[index].prefiltering)
    }

    /**
    * Get the transducer type info for a given signal index.
    * @param index - Index of the signal.
    * @returns The transducer type, null if signal index is out of range.
    */
    getSignalTransducerType (index: number): string | null {
        if (index < 0 || index >= this._header.signalInfo.length) {
            Log.warn(`Signal index ${index} is out of range, cannot return signal transducer type.`, SCOPE)
            return null
        }
        return this._header.signalInfo[index].transducerType
    }

}
