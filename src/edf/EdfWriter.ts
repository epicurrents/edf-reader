/**
 * Epicurrents EDF writer.
 * @package    epicurrents/edf-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericBiosignalHeader, GenericSignalWriter } from '@epicurrents/core'
import type { SignalDataGapMap, SignalDataWriter, TypedNumberArray } from '@epicurrents/core/dist/types'
import EdfEncoder from './EdfEncoder'
import type { EdfHeader } from '#types'
import { Log } from 'scoped-event-log'

const SCOPE = 'EdfWriter'

export default class EdfWriter extends GenericSignalWriter implements SignalDataWriter {
    protected _encoder: EdfEncoder

    constructor () {
        const encoder = new EdfEncoder('eeg')
        super(encoder)
        this._encoder = encoder // Required for TypeScript to recognize the encoder type.
    }

    setBiosignalHeader (header: GenericBiosignalHeader): void {
        this._encoder.setHeader(header)
        super.setBiosignalHeader(header)
    }

    setDataGaps (dataGaps: SignalDataGapMap): void {
        this._encoder.setDataGaps(dataGaps)
        super.setDataGaps(dataGaps)
    }

    setFileTypeHeader (header: unknown): void {
        this._encoder.setEdfHeader(header as EdfHeader)
        super.setFileTypeHeader(header)
    }

    setSourceArrayBuffer (buffer: ArrayBuffer): void {
        const typedBuffer = new Int16Array(buffer)
        this._encoder.setEdfSignalBuffer(typedBuffer)
        super.setSourceArrayBuffer(buffer)
    }

    setSourceDigitalSignals(signals: TypedNumberArray[]): void {
        if (signals.some(signal => !(signal instanceof Int16Array))) {
            Log.error('All digital signals must be Int16Arrays for EDF format.', SCOPE)
        } else {
            this._encoder.setEdfSignals(signals as Int16Array[])
        }
        super.setSourceDigitalSignals(signals)
    }

    async writeRecordingToArrayBuffer() {
        try {
            const buffer = await this._encoder.encode()
            if (buffer) {
                Log.debug('Successfully wrote EDF recording to ArrayBuffer.', SCOPE)
            } else {
                Log.error('Failed to write EDF recording to ArrayBuffer.', SCOPE)
            }
            return buffer
        } catch (error) {
            Log.error(`Error writing EDF recording: ${error}`, SCOPE)
            return null
        }
    }

    async writeRecordingToFile (fileName: string) {
        try {
            const buffer = await this._encoder.encode()
            if (buffer) {
                Log.debug(`Successfully wrote EDF recording to file.`, SCOPE)
                return this._blobToFile(new Blob([buffer]), fileName)
            } else {
                Log.error(`Failed to write EDF recording to file.`, SCOPE)
                return null
            }
        } catch (error) {
            Log.error(`Error writing EDF recording to file: ${error}`, SCOPE)
            return null
        }
    }

    writeRecordingToStream (): ReadableStream | null {
        Log.error('Writing EDF recordings to streams is not supported.', SCOPE)
        return null
    }
}
