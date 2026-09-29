# @epicurrents/edf-reader — architecture notes for AI coding assistants

This file is the entry point for AI coding assistants working in the `@epicurrents/edf-reader` package: an EDF/BDF file reader for the Epicurrents viewer. It is also the **reference implementation of the reader pattern** — every `*-reader` package (`csv-reader`, `nic-reader`, `wav-reader`, `dicom-reader`, …) follows the same source layout and the same worker/service contract described below, so the layout section is a convention other readers copy rather than an EDF-specific accident. It is tool-agnostic: the conventions apply to any assistant.

## Toolchain compliance — HIGH PRIORITY

This package depends on `@epicurrents/core` and shares a single toolchain with it. **Never pin package-specific versions that diverge from the canonical set** — a divergent TypeScript produces structurally incompatible `.d.ts` files that type-check locally but corrupt data at runtime, because the worker bundle and the main-thread code can then disagree on data layouts or API shapes while everything still compiles.

| Tool | Version |
|---|---|
| `@epicurrents/core` | `^2.0.0` |
| TypeScript | `^5.7.0` |
| Vite | `^7.3.1` |
| ESLint | `^9.19.0`, flat config in [eslint.config.mjs](eslint.config.mjs) |
| tsconfig base | extends `@epicurrents/core/tsconfig.base.json` |

The core version appears in `devDependencies`, `peerDependencies` and in the APIs the source actually calls, and the three must agree. The workspace symlinks core rather than installing it, so a stale range builds perfectly against whatever is checked out and only an external consumer sees the mismatch. Bump the range in the same commit as any change that depends on a new core API.

Do not override [tsconfig.base.json](../core/tsconfig.base.json) options per-package without a comment explaining why.

```bash
npm run build          # build:workers then build:tsc — produces BOTH outputs (see below)
npm run build:tsc      # vite + epicurrents-build-types → dist/  (what consumers import)
npm run build:workers  # vite → umd/edf.worker.js and umd/edf.writer.worker.js
npm test               # vitest run --coverage
```

Both outputs must be regenerated together after any shared-code change: `dist/` carries the reader worker inlined and `umd/` holds the standalone bundles, so rebuilding one leaves a mismatch the type system cannot see. Declarations are emitted and their `#` aliases rewritten by `epicurrents-build-types`, the tool core publishes as a bin; nothing here invokes `tsc` for emit.

---

## File reader concept

**Pattern shared by all `*-reader` packages.**

```
src/
  index.ts              # public exports
  edf/
    index.ts            # barrel — the package's public API surface
    EdfReader.ts        # extends GenericSignalReader — reads & caches data records
    EdfDecoder.ts       # binary → typed-array conversion
    EdfEncoder.ts       # typed-array → binary (for writing)
    EdfHeaderRecord.ts  # typed representation of an EDF header
    EdfImporter.ts      # extends GenericStudyImporter — entry point for "open file"
    EdfExporter.ts      # extends GenericStudyExporter
    EdfWriter.ts        # wraps EdfEncoder for writing
    EdfWorkerSubstitute.ts# fallback when no web worker is available
    encodePayload.ts    # the pure encode step, shared by the exporter and the writer worker
  workers/
    edf.worker.ts       # reader worker; a SignalReaderWorker subclass around EdfReader
    edf.writer.worker.ts# writer worker; runs the encode step off the main thread
  types/                # EDF-specific TypeScript types
  util.ts               # EDF header → BiosignalHeader, plus modality, prefiltering and text helpers
```

`EdfReader` extends `GenericSignalReader` (from `@epicurrents/core`). Key method: `cacheEdfInfo(header, dataRecordSize)` — stores offsets + chunk sizing into the base class so the worker can stream data records progressively.

Vitest suites live in [tests/](tests/). The write path is covered through the encoder, an encode/decode round trip and the exporter; the read path through the decoder, the reader, the importer, the header record and the utilities. [tests/edfFile.ts](tests/edfFile.ts) builds EDF and BDF bytes for those — the encoder cannot serve, because it writes only continuous EDF with no annotation channel, and the TAL state machine, interruption detection and the three-byte BDF sample are exactly what it never produces.

A new reader package mirrors this shape: a `<Format>Reader` extending `GenericSignalReader`, a `<Format>Importer` extending `GenericStudyImporter`, a `<Format>WorkerSubstitute` for the non-worker path, one `src/workers/<format>.worker.ts` entry, format types under `src/types/`, and a `src/util.ts` translating the format's header into the core's `BiosignalHeader` shape.

---

## Reader internals

### GenericSignalReader (from `@epicurrents/core`)

Runs **inside the format worker**. Key design:
- `_readAndCachePart(startRecord, process?)` → `_readSignalPart(start, end)` → `_readPartFromFile(start, length)` → HTTP `Range: bytes=start-end` fetch or `File.slice()` → blob → `decoder.decodeData()`
- Progressive loading: `cacheSignals()` loops `_readAndCachePart`, yielding `SETTINGS.app.signalLoadingYieldMs` (default 50) between chunks so the worker thread stays responsive. The in-flight read is exposed on the cache process, so a release can drain it rather than race it. Progress goes back through `_updateCallback` (the main thread updates `signalCacheStatus`).
- Two cache types: `BiosignalMutex` (SAB path, preferred) or `BiosignalCache` (JS heap fallback).
- `_awaitData` promise: if `getSignals(range)` is called before that range is cached, a timeout promise awaits until the background caching loop covers the requested range.

### Interruption handling

Discontinuous EDF+: cache stores signal in **data time** (gap-exclusive). `_readSignalPart` computes `priorGaps` (total interruption time before range) and `innerGaps` (within range). `getSignals` fills interruption periods with zeros in the output.

An interruption is discovered from the timekeeping annotation each EDF+ data record opens with: where a record states a start later than its position in the file would put it, the difference is the gap before it. `decodeData` keys the interruption by **data** time, not recording time, because the record's own timestamp cannot always be trusted, and accumulates `priorOffset` so each later record is measured against the ones before it.

**That accumulation is what `EdfReader.setupStudy` relies on to find a discontinuous file's true length.** It decodes the last data record alone, with `startRecord` and `priorOffset` both zero, so the interruption the decoder reports at data position 0 is the whole distance from the file's start to that record's start — every preceding record plus every gap between them. The recording ends one record duration later. Reading that line as "the gaps" and adding the data length instead double-counts the data.

### EDF reader worker

[src/workers/edf.worker.ts](src/workers/edf.worker.ts) is a thin `SignalReaderWorker` subclass (from `@epicurrents/core/workers`) holding one `EdfReader`. The commission vocabulary is the base class's, not this package's: `setup-cache`, `cache-signals`, `get-signals`, `request-signals` (the view-anchored rolling-window protocol, which answers twice — an interim reply with `final: false`, then the terminal state), `release-signal-arrays`, `release-cache`, `set-interruptions`, `set-signal-polarity`, `set-buffer-range`, `reset-network`, `shutdown` and `update-settings`. Read [core/src/workers/signal-reader.worker.ts](../core/src/workers/signal-reader.worker.ts) for the authoritative list; an action missing from the map leaves the calling service holding a promise that never settles.

The package contributes three things on top:

- **`setup-worker`**, registered through `extendActionMap`. The EDF header is **not** parsed here: `EdfImporter` reads the fixed 256-byte header and the per-signal block on the main thread, and both the `BiosignalHeaderRecord` and the format `EdfHeader` arrive as commission properties. The action validates them, applies the main-thread app-settings snapshot onto `SETTINGS.app` (load-bearing — `_buildDataBlocks` reads `maxLoadCacheSize` and `dataBlockDuration` from it), opens the study with the source (`url` or `file`, one required) and replies with `dataLength` and `recordingLength`.
- **`_signalResponseExtras`**, which carries the events and interruptions discovered while decoding back with each signal response.
- **`resetNetwork`** and a network-status handler that posts `network-status` messages to the main thread.

`release-signal-arrays` is the soft-release (Level 1) commission of the core's three-level cache lifecycle; `release-cache` is the full teardown (Level 2). The lifecycle contract itself is documented in `@epicurrents/core` — a reader only has to implement both commissions and let Level 2 cascade through Level 1.

### EdfDecoder

`decodeData(header, buffer, dataOffset, startRecord, range, priorOffset, returnRaw)` → `{ events, interruptions, signals }`, where `signals` is `number[][]` of physical values, or the raw digital equivalent under `returnRaw`. The digital→physical conversion uses the precomputed form `unitsPerBit × (raw + digitalOffset) × scale` rather than recomputing the range ratio per sample. EDF+ TAL records are parsed for events and interruptions inline.

**A sample is two bytes in EDF and three in BDF, and that width is load-bearing in two places.** `EdfDecoder` reads it off the data format, and `EdfHeaderRecord` derives `dataUnitSize` from it — the stride `GenericSignalReader` seeks the file by. Hardcoding two there does not corrupt a sample; it lands every read of a BDF file between samples, and nothing in the type system or in a continuous-EDF test can see it.

**A short read never fails, it pads.** `unpackString` from `byte-data` answers a read past the end of its buffer with replacement characters rather than an error or a null, so a header record whose buffer stops inside the signal block parses into NaN sample counts and physical ranges — a header that looks decoded and describes nothing. `decodeHeader` therefore checks the buffer against `256 + signalCount*256` before it parses the block, and refuses a digital range of zero width for the same reason: the division that derives `unitsPerBit` from it yields Infinity, and every sample of that signal decodes as NaN.

**The annotation channel is named after the format.** It is `EDF Annotations` in an EDF+ file and `BDF Annotations` in a BDF+ one, so anything matching it does so case-insensitively against the format's own spelling. An exact match on the EDF name silently gives a BDF+ annotation channel a sampling rate it does not have, and the channel is then displayed as a signal.

### Key design insight

The format worker is pure message-in/message-out. It has no knowledge of any UI framework or of the application runtime — only `WorkerMessage` / `WorkerResponse`. The format-specific service on the main thread (for EEG recordings, `@epicurrents/eeg-module`'s `EegService`) owns the worker lifecycle.

`EdfWorkerSubstitute` is the no-worker path: it extends `ServiceWorkerSubstitute` and answers the same messages asynchronously, driving its own `EdfReader` on the main thread. It also answers `decommission`, which the worker does not.

---

## EDF exporter

`EdfExporter` (`GenericStudyExporter`) writes a recording back out as a de-identified EDF plus a metadata sidecar. Its public surface is `encodeResource`, `convertResource` (the import-to-export conversion path, which pulls signals through `BiosignalResource.loadAndCacheSignals()`), `exportActiveResource` and `exportStudyToFileSystem`; `exportStudyToDataset` is declared but not yet supported.

Events and labels reach the sidecar as templates, reduced in `EdfExporter` from the live assets: an asset serialised whole would carry its internal state under private names, and the template is what the sidecar's type promises. An event's `codes` ride along, which is how a recording the viewer has coded against the shared vocabularies keeps those codes through export.

Every export passes through core's `applyExportSelection`, with the `selection` option or, without one, the whole recording, so reducing a recording (a range, reordered and relabelled channels, one output rate, an amplitude range) is the same operation for every exporter and this package holds no reason for making one. The exporter's own part is what the transform cannot know. Event channel references point into the record montage, and numeric ones are converted to channel-list indices before the transform, since the montage leaves meta channels out. Amplitude ranges arrive in each channel's unit and are scaled to the base-unit signals for clipping, then written as given into the header's physical range, which otherwise holds the samples' extremes. A downsampled channel's low-pass is lowered to the anti-aliasing cutoff, a relabelled channel's sidecar `name` becomes its new label so the source name does not ride along, and the start time moves to the start of the range. The output rate has to be a whole number of hertz, because the file is written in one-second records. The whole recording is still read and the range cut from it, because the signal cache is indexed in data time.

With `embedFooter`, the exporter produces the container the platform ingests: the same EDF with the sidecar appended as a footer after the last data record, marked in the header's reserved field as `EDF EC:<byte size of header and records>:<footer size in whole KiB>`. The container is plain EDF whatever the recording's continuity, since the file carries no annotation channel and the footer carries the interruptions, and the footer is de-identified whenever the file is. The platform detaches the footer at ingest and stores the EDF alone. Its plain upload reads no sidecar file, so a recording meant for it travels as the container; a pooled submission is the exception, sending a plain EDF with the sidecar beside it, which the submission gate reads.

`removeMetadataKeys` leaves every property so named out of the sidecar and the footer, at any depth, through a `JSON.stringify` replacer in `EdfEncoder`, so the sidecar's type is untouched and array indices never match. It exists because de-identification keeps the shape (`subject` with null fields, events and labels with an empty `text`) while a destination may refuse the keys themselves; the export dialog fills it from a target's `forbiddenMetadataKeys`.

### The header the encoder writes

**An EDF header field is eight ASCII characters and no more, and both halves of that bite.** A number rendered with `toString` is written into the field character by character, so a physical range that needs more than eight — anything in exponent notation, which is every magnitude below `1e-6` — is cut rather than rounded: the first eight characters of `(-1.2345e-7).toString()` are `-1.2345e`, which parses back as `1.2345`, the sign gone and the magnitude out by seven orders. `#numericField` renders a number to fit instead. And `setUint8` stores the low byte of a code point, so a `µ` written straight from a unit field becomes an unrelated Latin-1 byte; `writeAsciiField` writes a space for anything outside printable ASCII.

**The header declares the signals it writes, which is not what it was handed.** `#includedSignals` drops the annotation channel on top of whatever `setSignalsToInclude` named, so the signal count and the header size both have to come from that map. Taking them from `#header.signalCount` declares a channel the file does not hold, and a reader then parses the first data record as though it had one.

**The start date and time are local, and they are two fields written together.** `dd.mm.yy` then `hh.mm.ss`, sixteen characters, stating the recording's own local time — which is how `EdfDecoder` reads them back, with `new Date(year, month, day, …)`. Deriving them from `toISOString()` writes UTC and reads back shifted by the writer's offset. The de-identified branch writes a fixed placeholder and takes none of this path, so a fault here is invisible to any test that only exports de-identified.

**`encode` writes the footer before the header on purpose.** The container marker names the footer's size, so the header cannot be written until the footer exists — and it must be *that* footer, written with the de-identification and the removed keys the export asked for. A header writer that builds one itself takes the defaults of those arguments and embeds unredacted metadata into a file whose header says it is de-identified.

The encode step itself lives in [src/edf/encodePayload.ts](src/edf/encodePayload.ts), free of DOM and worker APIs, so it runs on either thread. `EdfExporter._encode` uses a worker when the host has supplied a factory through `setWorkerOverride` and falls back to encoding in place when it has not — nothing in this package constructs the writer worker, which is why it is built only into `umd/` and why `dist/workers/` holds its declaration but no module.

---

## Worker bundle exports

The reader worker is inlined into `dist/`: `EdfImporter` imports it through Vite's `?worker&inline` and constructs it as the default, so a consumer that registers nothing gets a working worker with no file to serve, copy or resolve.

The `umd/` bundles are the escape hatch. A consumer whose content security policy forbids `worker-src blob:` serves `umd/edf.worker.js` and registers a URL-based factory, which takes precedence over the inlined default; the writer worker is only ever acquired this way. Both are self-contained and reachable through two `exports` keys in [package.json](package.json):

```json
"./workers/*": "./umd/*",
"./umd/*": "./umd/*"
```

They suit `inlineWorker(src)` after a `?raw` import — `import edf from '@epicurrents/edf-reader/workers/edf.worker.js?raw'` — which is how the builder's own setup wires them. The modules under `dist/workers/` are the inlined copy and its declarations, not runnable standalone workers; do not `?raw`-import those for inlining.

---

## Code comment conventions

Comments and docstrings describe the code's **current contract** — what it does and the invariants it upholds, for a reader who has never seen an earlier version.

- **No change history or anecdotes.** Don't narrate what the code used to do, what a change replaced, or why it was added. That belongs in the commit message, where `git blame` surfaces it; in the file it rots as soon as the change lands.
- **Describe the layer's own contract, not its consumers.** A reader or worker comment shouldn't name a specific upper-layer caller — state the invariant the layer guarantees so it holds regardless of who calls it.
- **Keep the `@package` / `@copyright` / `@license` header** on every source file.
- **Wrap TypeScript source at a 120-column soft cap** — code, docstrings, and comments alike. The one exception: `@param` docstrings stay on a single line regardless of length, because wrapping them renders poorly in the VS Code hover. Do not hard-wrap Markdown prose: one line per paragraph, since docs are read as rendered output at varying widths.
