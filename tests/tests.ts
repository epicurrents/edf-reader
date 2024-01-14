/**
 * EpiCurrents file loader tests.
 * Due to the high level of integration, tests must be run sequentially.
 * This file describes the testing sequence and runs the appropriate tests.
 * @package    @epicurrents/edf-file-loader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import EdfFileLoader from '../src/edf/EdfFileLoader'

describe('EpiCurrents EDF file loader tests', () => {
    test('Create and instance of file loader', () => {
        const loader = new EdfFileLoader()
        expect(loader).toBeDefined()
    })
})
