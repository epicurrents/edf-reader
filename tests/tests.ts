/**
 * EpiCurrents file loader tests.
 * Due to the high level of integration, tests must be run sequentially.
 * This file describes the testing sequence and runs the appropriate tests.
 * @package    @epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

import EdfReader from '../src/edf/EdfReader'

describe('EpiCurrents EDF file loader tests', () => {
    test('Create and instance of file loader', () => {
        const loader = new EdfReader()
        expect(loader).toBeDefined()
    })
})
