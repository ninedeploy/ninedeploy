import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The barrel is pure re-exports: v8 coverage never credits `export *`
      // statements as executed, so a structural 0% would make the 100% gate
      // impossible no matter how complete the tests are.
      exclude: ['src/index.ts'],
      reporter: ['text'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
