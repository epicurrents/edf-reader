# @epicurrents/edf-reader — roadmap

What the September 2026 audit left open, roughly in the order the work would pay off.

## Open defects

**`EdfWriter` has no consumer and no test.** Nothing in the workspace, the interface or the platform imports it; the export path runs through `EdfExporter` and `encodePayload` instead. Two things in it are wrong for a class nobody exercises to be carrying: `setSourceArrayBuffer` reads its buffer as `Int16Array`, so a BDF source would be misread and an odd byte length throws, and the constructor hardcodes `new EdfEncoder('eeg')` rather than taking the recording's modality. Either give it a caller and a test, or drop it from the package entry.

**The contiguous digital source buffer is accepted and ignored.** `EdfEncoder.setEdfSignalBuffer` stores a buffer that `#writeSignalBuffer` then warns about and passes over. It is the path that would let a recording be re-encoded without a digital-to-physical round trip, and it is the only one `EdfWriter.setSourceArrayBuffer` feeds.

**Discontinuous output is not written.** An `EDF+D` file needs an annotation channel to carry its record timestamps, which the encoder does not write, so a discontinuous recording is exported as a continuous file with a warning. The interruptions survive in the sidecar, so nothing is lost where the sidecar travels with the file — but a plain EDF export of a discontinuous recording states a timeline it does not have.

**`textToUTF8Array` in [src/util.ts](src/util.ts) is unused.** It carries a note saying it is kept in case a polyfill is ever needed; `TextEncoder` is used unguarded two files over, so the polyfill case has already been decided against. Sixty lines of untested surrogate-pair arithmetic.

**The decoder rebuilds a whole header record on every data read.** `decodeData` ends by constructing a new `EdfHeaderRecord` from the header it was given, which re-derives every signal's properties, for a chunk of a few seconds. It also leaves `decoder.output` describing the last chunk read rather than the file, which is why `EdfReader.setupStudy` has to clear the events and interruptions after reading the last record for the file's duration.

**`EdfExporter._encodeViaWorker` waits forever.** A worker that never replies leaves the promise unsettled, and the signal buffers are transferred before the post, so a failed encode cannot be retried from the same payload.

## Coverage

The write path was well covered and still carried a corrupt start date through every non-de-identified export, because the only date assertion it had was on the de-identified branch, which writes a fixed placeholder and takes none of that code. The lesson generalises: a de-identifying writer has two paths and a test that exercises one says nothing about the other. The read path is now covered at its intricate parts — the TAL state machine, interruption detection, the three-byte BDF sample, the header fields. What is still untested:

- `EdfWorkerSubstitute` beyond setup and cache release: `get-signals`, `cache-signals` and the two-stage `request-signals` protocol, which is the path every page that is not cross-origin isolated takes.
- `EdfImporter.importUrl`, and with it the ranged fetch of the header and the signal block.
- The writer worker, which has no test at all.
- `EdfWriter`, at nought per cent, for the reason above.

## Smaller things

- `EdfDecoder.decodeHeader` parses the start date without checking the field's shape: a malformed `dd.mm.yy` yields an `Invalid Date` rather than a refusal, and the recording opens with no start time.
- `EdfReader.cacheEdfInfo` computes `_chunkUnitCount` as `floor(dataChunkSize/dataUnitSize) - 1` with no comment saying what the subtraction is for.
- `EdfEncoder.amplitudeRanges` falls back to `[0, 1]` for a modality it does not know, which would clip a signal to nothing. Every current caller sets a per-index range, so the fallback is unreachable today.
- The `#dataEncoding` constructor argument is stored and exposed but never read; the encoder writes `Int16` regardless.
