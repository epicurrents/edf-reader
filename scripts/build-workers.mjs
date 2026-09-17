/**
 * Standalone worker bundles — the escape hatch from inlining.
 *
 * `dist/` inlines the worker as a Blob, which requires `worker-src blob:` in the consumer's content
 * security policy. A consumer that cannot grant it serves these files instead and registers a
 * URL-based factory, which takes precedence over the inlined default.
 *
 * Each worker is bundled separately because IIFE output cannot be code-split, and self-contained
 * because a worker resolves no bare specifiers of its own.
 * @package    epicurrents/edf-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */
import { build } from 'vite'
import { ALIASES, abs, minifyWorkerOutput } from '../vite.shared.mjs'

// The reader worker is also inlined into dist; the writer worker exists only here, because the host
// injects its factory rather than the exporter constructing one.
const WORKERS = ['edf', 'edf.writer']

for (const name of WORKERS) {
    await build({
        configFile: false,
        logLevel: 'warn',
        build: {
            lib: {
                entry: abs(`./src/workers/${name}.worker.ts`),
                name: 'EpiCWorker',
                formats: ['iife'],
                fileName: () => `${name}.worker.js`,
            },
            minify: false,
            outDir: abs('./umd'),
            emptyOutDir: false,
            target: 'esnext',
            rollupOptions: {
                output: {
                    inlineDynamicImports: true,
                },
            },
        },
        plugins: [minifyWorkerOutput()],
        resolve: {
            alias: ALIASES,
        },
    })
    console.log(`built umd/${name}.worker.js`)
}
