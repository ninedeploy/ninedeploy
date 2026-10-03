import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text'],
      // The MCP surface is the operator-facing companion to the
      // server's permission model. 100% would force every
      // unreachable branch (e.g. the final `return true` in
      // `toolMeetsScope` after every required scope was matched)
      // through a fake. 90% is the realistic gate for an SDK-
      // shaped package; the 5-10% gap is dead defensive code.
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 95,
        lines: 95,
      },
    },
  },
});
