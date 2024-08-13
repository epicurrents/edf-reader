/**
 * Epicurrents EDF encoder. This class can be used to encode signal data into a custom EDF format.
 * @package    epicurrents/edf-reader
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

import {
    type EdfHeader,
    type EdfRecordingType,
    type FileFormatEncoder,
} from '#types'
import { Log } from 'scoped-ts-log'

const SCOPE = 'EdfEncoder'

export default class EdfEncoder implements FileFormatEncoder {
    protected _header = null as EdfHeader | null
    protected _recordingType: EdfRecordingType
    protected _signals = [] as Float32Array[]
    constructor (recordingType: EdfRecordingType) {
        this._recordingType = recordingType
    }

    setHeader (properties: EdfHeader) {
        this._header = properties
    }

    updateHeader (properties: Partial<EdfHeader>) {
        if (!this._header) {
            Log.error(`Cannot update header, current header property is empty.`, SCOPE)
            return
        }
        Object.assign(this._header, properties)
    }
}