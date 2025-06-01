/**
 * Epicurrents EDF reader.
 * @package    epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericFileWriter } from '@epicurrents/core'
import type {
    FileFormatWriter,
} from '@epicurrents/core/dist/types'
//import { Log } from 'scoped-event-log'
import EdfExporter from './EdfExporter'

//const SCOPE = 'EdfWriter'

export default class EdfWriter extends GenericFileWriter implements FileFormatWriter {
    protected _processor = new EdfExporter()

    constructor () {
        super('EdfWriter', 'edf', 'File writer for the Epicurrents EDF format.')
    }
}
