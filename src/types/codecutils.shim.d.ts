/**
 * EpiCurrents codecutils shim.
 * @package    @epicurrents/edf-file-loader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

declare module 'codecutils' {
    const CodecUtils: {
        extractTypedArray: any
        getString8FromBuffer: any
    }
}
