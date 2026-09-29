# @epicurrents/edf-reader

EDF and BDF reader for Epicurrents, and the reference implementation of the reader pattern every other `*-reader` package in the family follows. It reads the [European Data Format](https://www.edfplus.info/specs/index.html) and its BioSemi 24-bit sibling, in both the original and the `+` specification, and it is also the package that writes one: the exporter here is how a recording of any format the viewer can open leaves it as a de-identified EDF.

## Public surface

| Export | Role |
|---|---|
| `EdfImporter` | Opens an `.edf` or `.bdf` source, populates `study.meta` and hands out the worker. This is what the application calls. |
| `EdfReader` | Decodes the study inside the worker and fills the signal cache. |
| `EdfDecoder` | Turns header bytes into an `EdfHeader` and data records into per-channel signals. Usable on its own. |
| `EdfHeaderRecord` | A biosignal header built from an EDF header, carrying the decoded records where there are any. |
| `EdfWorkerSubstitute` | Runs the reader on the main thread where `SharedArrayBuffer` is unavailable. |
| `EdfExporter` | Writes a decoded resource back out as a de-identified EDF plus a metadata sidecar. |
| `EdfEncoder` | The encoder the exporter and the writer drive. |
| `EdfWriter` | A `SignalDataWriter` around the encoder, for a caller holding signals rather than a resource. |
| `encodePayload` | The pure encode step, free of DOM and worker APIs, so it runs on either thread. |

The helpers in [src/util.ts](src/util.ts) are internal.

## What it reads

An EDF file is a fixed 256-byte header, a 256-byte block per signal, and then the data records: each record holds one record-duration of every signal, one signal after another, as little-endian signed integers. A sample is two bytes in EDF and three in BDF, which is the only difference between the two that reaches the data. `recordByteSize` is the stride the reader seeks the file by, so a wrong sample width is not a rounding error but a read landing between samples.

Digital samples become physical values through the precomputed form of the specification's conversion, `unitsPerBit × (sample + digitalOffset) × scale`, where `scale` normalises the signal's own unit to the SI base unit — a channel recorded in microvolts is cached in volts, the convention every reader in the family follows. The unit each channel reports stays as the file wrote it, because that is what a consumer displays the signal against.

A digital range of zero width has no conversion to offer, so a header declaring one is refused rather than decoded into NaN. A buffer that stops inside the signal block is refused for the same reason: reading past the end of one yields replacement characters rather than an error, and those parse into NaN sample counts.

## EDF+ annotations and interruptions

An EDF+ file carries its annotations inside the signal stream, in a channel named `EDF Annotations` (`BDF Annotations` in a BDF+ file) whose samples are TAL text rather than numbers. Every data record opens with a timekeeping annotation stating the record's own start in recording time, and text annotations may follow it.

That opening timestamp is what makes a discontinuous (`EDF+D`) file readable. Where a record starts later than its position in the file would put it, the difference is the length of the gap before it, and the reader records it as an **interruption**: keyed by data time, so the signal cache stays gap-free and the interruptions are what map it back onto recording time. A recording is therefore as long as its data plus its gaps, and `EdfReader.setupStudy` resolves that by reading the last data record on its own — the interruption it reports at data position zero is the whole distance from the file's start to that record's start.

A continuous file records no interruption whatever its timestamps say, since the format guarantees its records are contiguous.

## The exporter

`EdfExporter` writes a decoded biosignal resource back out, whatever format it was read from, as a de-identified EDF plus a metadata sidecar. Its public surface is `encodeResource`, `convertResource` (the direct import-to-export path, which caches signals through `BiosignalResource.loadAndCacheSignals()` without activating the resource), `exportActiveResource` and `exportStudyToFileSystem`.

Every export passes through core's `applyExportSelection`, so reducing a recording — a range, reordered and relabelled channels, one output rate, an amplitude range — is the same operation for every exporter in the family. The output rate has to be a whole number of hertz, because the file is written in one-second records.

With `embedFooter` the exporter produces the container the platform ingests: the same EDF with the sidecar appended after the last data record, marked in the header's reserved field as `EDF EC:<byte size of header and records>:<footer size in whole KiB>`. The platform detaches the footer at ingest and stores the EDF alone.

With `dither`, each physical sample is offset by noise of under one digital step, from a cryptographic source, before it is rounded. The same recording exported twice then never gives the same bytes, so an export cannot be found by re-encoding a copy of the original and comparing hashes; the noise stays under one quantization step, so it does not stop correlating the two signals.

## Building

```bash
npm run build          # build:workers then build:tsc — produces BOTH outputs
npm run build:workers  # vite → umd/edf.worker.js and umd/edf.writer.worker.js
npm run build:tsc      # vite + epicurrents-build-types → dist/, carrying the reader worker inlined
npm run lint           # eslint src
npm test               # vitest run --coverage
```

`dist/` inlines the reader worker as a Blob, which needs `worker-src blob:` in the consumer's content security policy. A consumer that cannot grant it serves [umd/edf.worker.js](umd) instead and registers a URL-based factory, which takes precedence over the inlined default. The writer worker is only ever acquired that way: nothing in this package constructs it, so it is built into `umd/` alone.
