import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
    resolve: {
        alias: [
            { find: '#root/', replacement: fileURLToPath(new URL('./', import.meta.url)) },
            { find: '#', replacement: fileURLToPath(new URL('src/', import.meta.url)) },
        ],
    },
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reportsDirectory: 'tests/coverage',
        },
    },
})
