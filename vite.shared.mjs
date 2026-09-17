/**
 * Shared pieces of the Vite build configs.
 *
 * The package resolves its own workers at build time, so nothing downstream has to. Consumers get
 * plain ESM with no `import.meta.url`, no asset-base assumption and no worker file to copy.
 * @package    epicurrents/edf-reader
 * @copyright  2026 Sampsa Lohi
 * @license    Apache-2.0
 */
import { fileURLToPath, URL } from 'url'
import { createRequire } from 'module'
import { transform } from 'esbuild'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')

/** Resolve a path relative to the package root. */
export const abs = (p) => fileURLToPath(new URL(p, import.meta.url))

/**
 * Internal `#*` path aliases, mirroring the `paths` in tsconfig.json. The library build, the worker
 * build and the test suite all resolve through this one table; the package declares no `imports`
 * field, so an alias missing here fails to resolve rather than falling through to another mapping.
 *
 * Regular expressions rather than strings: a string alias matches only the exact id or the id
 * followed by `/`, so `'#'` would never match `#edf/EdfReader`.
 */
export const ALIASES = [
    { find: /^#root\//, replacement: abs('./') + '/' },
    { find: /^#(edf|types|util|workers)\b/, replacement: abs('./src') + '/$1' },
]

/**
 * Declared and peer dependencies stay bare imports in `dist/`, so a consumer installs one copy of
 * each rather than inheriting a bundled one. The peers matter more than the dependencies here: the
 * core package holds the runtime singletons this reader registers against, and a second bundled
 * copy of it would register against a different one. The worker is the deliberate exception — see
 * {@link WORKER}.
 */
export const externalDependencies = (id) => [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
].some(dep => id === dep || id.startsWith(`${dep}/`))

/**
 * Minify worker output regardless of the surrounding build's `minify` setting. The worker is
 * inlined into the bundle as a source string, so its size is paid by every consumer whether or not
 * it ever runs; the library around it stays unminified for debuggability.
 *
 * `legalComments: 'eof'` collects the bundled dependencies' licence notices at the end of the file
 * rather than leaving them interleaved, which triples the size of an inlined worker; dropping them
 * would ship Apache-2.0 code with its attribution removed.
 */
export const minifyWorkerOutput = () => ({
    name: 'epi-minify-worker',
    async renderChunk (code) {
        const result = await transform(code, { minify: true, legalComments: 'eof', target: 'esnext' })
        return { code: result.code, map: null }
    },
})

/**
 * Worker sub-build settings. Each worker is a self-contained classic (IIFE) bundle: it cannot
 * resolve a bare specifier against a Blob URL, so its dependencies are bundled in — including the
 * core package the library build externalises.
 */
export const WORKER = {
    format: 'iife',
    plugins: () => [minifyWorkerOutput()],
    rollupOptions: {
        treeshake: true,
        output: {
            inlineDynamicImports: true,
        },
    },
}
