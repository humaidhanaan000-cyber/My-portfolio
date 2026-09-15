import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Unit / integration test configuration.
 *
 * The suite runs against the real database layer using the embedded PGlite
 * driver (no external services, no Docker, no network). Files run sequentially
 * because they share one database directory.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
