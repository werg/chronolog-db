import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 75,
        lines: 70,
      },
    },
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
