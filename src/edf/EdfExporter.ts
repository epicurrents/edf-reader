/**
 * Epicurrents EDF exporter.
 * @package    epicurrents/edf-reader
 * @copyright  2025 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericSignalWriter } from '@epicurrents/core'
import { SignalDataWriter } from '@epicurrents/core/dist/types'
import EdfEncoder from './EdfEncoder'

export default class EdfExporter extends GenericSignalWriter implements SignalDataWriter {

    constructor () {
        super(new EdfEncoder('eeg'))
    }
}
