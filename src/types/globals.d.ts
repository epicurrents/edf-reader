/**
 * Build-time global declarations. The Epicurrents application global (`window.__EPICURRENTS__` and
 * its `EpicurrentsGlobal` type) is inherited from `@epicurrents/core`; only bundler-level globals
 * are declared here.
 * @package    @epicurrents/edf-reader
 * @copyright  2024 Sampsa Lohi
 * @license    Apache-2.0
 */

/* eslint-disable */
/** Path where WebPack serves its public assets (js) from. */
declare let __webpack_public_path__: string
