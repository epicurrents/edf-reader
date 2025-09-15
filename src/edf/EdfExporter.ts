/**
 * Epicurrents EDF exporter.
 * @package    epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import { GenericStudyExporter } from '@epicurrents/core'
import type {
    FileFormatExporter,
} from '@epicurrents/core/dist/types'
//import { Log } from 'scoped-event-log'
import EdfWriter from './EdfWriter'

//const SCOPE = 'EdfExporter'

export default class EdfExporter extends GenericStudyExporter implements FileFormatExporter {
    protected _processor = new EdfWriter()

    constructor () {
        super('EdfExporter', 'edf', 'File writer for the Epicurrents EDF format.')
    }
}
