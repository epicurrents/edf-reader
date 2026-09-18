# @epicurrents/edf-reader — architecture notes for AI coding assistants

This file is the entry point for AI coding assistants working in the `@epicurrents/edf-reader` package: an EDF/BDF file reader for the Epicurrents viewer. It is also the **reference implementation of the reader pattern** — every `*-reader` package (`csv-reader`, `nic-reader`, `wav-reader`, `dicom-reader`, …) follows the same source layout and the same worker/service contract described below, so the layout section is a convention other readers copy rather than an EDF-specific accident. It is tool-agnostic: the conventions apply to any assistant.

## Toolchain compliance — HIGH PRIORITY

This package depends on `@epicurrents/core` and shares a single toolchain with it. **Never pin package-specific versions that diverge from the canonical set** — a divergent TypeScript produces structurally incompatible `.d.ts` files that type-check locally but corrupt data at runtime, because the worker bundle and the main-thread code can then disagree on data layouts or API shapes while everything still compiles.

| Tool | Version |
|---|---|
| TypeScript | `^5.7.0` |
| Vite | `^7.3.1` |
| tsconfig base | extends `@epicurrents/core/tsconfig.base.json` |

Do not override `tsconfig.base.json` options per-package without a comment explaining why.

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

Vitest suites live in [tests/](tests/), covering the encoder, an encode/decode round trip and the exporter.

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

### EDF reader worker

[src/workers/edf.worker.ts](src/workers/edf.worker.ts) is a thin `SignalReaderWorker` subclass (from `@epicurrents/core/workers`) holding one `EdfReader`. The commission vocabulary is the base class's, not this package's: `setup-cache`, `cache-signals`, `get-signals`, `request-signals` (the view-anchored rolling-window protocol, which answers twice — an interim reply with `final: false`, then the terminal state), `release-signal-arrays`, `release-cache`, `set-interruptions`, `set-signal-polarity`, `set-buffer-range`, `reset-network`, `shutdown` and `update-settings`. Read [core/src/workers/signal-reader.worker.ts](../core/src/workers/signal-reader.worker.ts) for the authoritative list; an action missing from the map leaves the calling service holding a promise that never settles.

The package contributes three things on top:

- **`setup-worker`**, registered through `extendActionMap`. The EDF header is **not** parsed here: `EdfImporter` reads the fixed 256-byte header and the per-signal block on the main thread, and both the `BiosignalHeaderRecord` and the format `EdfHeader` arrive as commission properties. The action validates them, applies the main-thread app-settings snapshot onto `SETTINGS.app` (load-bearing — `_buildDataBlocks` reads `maxLoadCacheSize` and `dataBlockDuration` from it), opens the study with the source (`url` or `file`, one required) and replies with `dataLength` and `recordingLength`.
- **`_signalResponseExtras`**, which carries the events and interruptions discovered while decoding back with each signal response.
- **`resetNetwork`** and a network-status handler that posts `network-status` messages to the main thread.

`release-signal-arrays` is the soft-release (Level 1) commission of the core's three-level cache lifecycle; `release-cache` is the full teardown (Level 2). The lifecycle contract itself is documented in `@epicurrents/core` — a reader only has to implement both commissions and let Level 2 cascade through Level 1.

### EdfDecoder

`decodeData(header, buffer, dataOffset, startRecord, range, priorOffset, returnRaw)` → `{ events, interruptions, signals }`, where `signals` is `number[][]` of physical values, or the raw digital equivalent under `returnRaw`. The digital→physical conversion uses the precomputed form `unitsPerBit × (raw + digitalOffset) × scale` rather than recomputing the range ratio per sample. EDF+ TAL records are parsed for events and interruptions inline.

### Key design insight

The format worker is pure message-in/message-out. It has no knowledge of any UI framework or of the application runtime — only `WorkerMessage` / `WorkerResponse`. The format-specific service on the main thread (for EEG recordings, `@epicurrents/eeg-module`'s `EegService`) owns the worker lifecycle.

`EdfWorkerSubstitute` is the no-worker path: it extends `ServiceWorkerSubstitute` and answers the same messages asynchronously, driving its own `EdfReader` on the main thread. It also answers `decommission`, which the worker does not.

---

## EDF exporter

`EdfExporter` (`GenericStudyExporter`) writes a recording back out as an anonymised EDF plus a metadata sidecar. Its public surface is `encodeResource`, `convertResource` (the import-to-export conversion path, which pulls signals through `BiosignalResource.loadAndCacheSignals()`), `exportActiveResource` and `exportStudyToFileSystem`; `exportStudyToDataset` is declared but not yet supported.

The encode step itself lives in [src/edf/encodePayload.ts](src/edf/encodePayload.ts), free of DOM and worker APIs, so it runs on either thread. `EdfExporter._encode` uses a worker when the host has supplied a factory through `setWorkerOverride` and falls back to encoding in place when it has not — nothing in this package constructs the writer worker, which is why it is built only into `umd/` and why `dist/workers/` holds its declaration but no module.

---

## Worker bundle exports

The reader worker is inlined into `dist/`: `EdfImporter` imports it through Vite's `?worker&inline` and constructs it as the default, so a consumer that registers nothing gets a working worker with no file to serve, copy or resolve.

The `umd/` bundles are the escape hatch. A consumer whose content security policy forbids `worker-src blob:` serves `umd/edf.worker.js` and registers a URL-based factory, which takes precedence over the inlined default; the writer worker is only ever acquired this way. Both are self-contained and reachable through two `exports` keys in `package.json`:

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
