/**
 * Global type aliases for the typed arrays the encoder is parameterised over.
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
