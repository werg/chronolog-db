import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
  },
})

