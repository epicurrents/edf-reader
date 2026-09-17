/**
 * Non-typed module declarations.
 * @package    epicurrents/edf-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */

/* eslint-disable */

/**
 * Worker bundled and inlined by the build. The bundle is self-contained and carries its own copy of
 * every dependency, so the constructed worker resolves nothing at runtime.
 */
declare module '*?worker&inline' {
    const InlinedWorker: new (options?: { name?: string }) => Worker
    export default InlinedWorker
}
