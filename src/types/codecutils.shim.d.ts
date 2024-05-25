/**
 * Epicurrents codecutils shim.
 * @package    epicurrents/edf-reader
 * @copyright  2023 Sampsa Lohi
 * @license    Apache-2.0
 */

declare type TypedNumberArray = Float32Array |
                                Int8Array | Int16Array | Int32Array |
                                Uint8Array | Uint16Array | Uint32Array
declare type TypedNumberArrayConstructor = Float32ArrayConstructor |
                                           Int8ArrayConstructor | Int16ArrayConstructor | Int32ArrayConstructor |
                                           Uint8ArrayConstructor | Uint16ArrayConstructor | Uint32ArrayConstructor
declare module 'codecutils' {
    // From the library documentation.
    const CodecUtils: {
        /**
         * Extract a typed array from an arbitrary buffer, with an arbitrary offset
         * @param buffer - the buffer from which we extract data
         * @param byteOffset - offset from the begining of buffer
         * @param arrayType - function object, actually the constructor of the output array
         * @param numberOfElements - nb of elem we want to fetch from the buffer
         * @return output of type given by arg arrayType - this is a copy, not a view
         */
        extractTypedArray (
            buffer: ArrayBuffer,
            byteOffset: startFrom,
            arrayType: TypedNumberArrayConstructor,
            numberofElements: number
        ): TypedNumberArray
        /**
         * Extract an ASCII string from an ArrayBuffer
         * @param buffer - the buffer
         * @param strLength - number of chars in the string we want
         * @param byteOffset - the offset in number of bytes
         * @return the string, or null in case of error
         */
        getString8FromBuffer (buffer: ArrayBuffer, strLength: number, byteOffset: number): string | null
    }
}
