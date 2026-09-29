import { defineConfig } from 'vitest/config'
import { ALIASES } from './vite.shared.mjs'

export default defineConfig({
    resolve: {
        alias: ALIASES,
    },
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['tests/**/*.test.ts'],
        coverage: {
            // Without `all`, coverage reports only the files a test happened to import, so a
            // source file nothing covers is missing from the report rather than shown at zero.
            all: true,
            include: ['src/**'],
            provider: 'v8',
            reportsDirectory: 'tests/coverage',
        },
    },
})
