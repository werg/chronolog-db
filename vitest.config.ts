import { coverageConfigDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        // Process entry points: top-level argv/env wiring that runs on import, so it is
        // only exercisable as a subprocess (distribution upgrade drill, e2e, container chaos).
        'apps/*/src/main.ts',
        'apps/chronologd/src/custody.ts',
        'apps/chronologd/src/snapshot.ts',
        'packages/chaos/src/cli.ts',
        // Runnable demo, not shipped code.
        'examples/**',
        // Throwaway workerd/WASM spike scripts; explicitly not a supported surface.
        'experimental/**',
        // Release/doc CLI scripts executed by CI jobs; their library logic (tools/lib) stays in coverage.
        'tools/*.ts',
        'tools/*.mjs',
        // Unfinished, unwired, untested review-packet builder (see docs/drill-evidence.md).
        'tools/lib/review-packet.ts',
      ],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 75,
        lines: 70,
      },
    },
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'test/**/*.test.ts', 'tools/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
