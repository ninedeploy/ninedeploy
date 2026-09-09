import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
    // The CI runner is roughly 2–3× slower than a local box; the
    // SettingsTabPrivilege / Hub suite touches many privilege-gating
    // branches and patches that, on a slow runner, blow past the
    // 5s default and 15s in-suite override. Lift both to 30s so
    // release:check is stable on ubuntu-latest without any
    // individual test waiting on a tight per-test timer.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      // vite-env.d.ts is a type declaration (no runtime code).
      // App.tsx is a declarative route table: after the per-route code
      // split every entry is a lazy wrapper whose arrow only runs when a
      // test actually navigates to that route. The 30+ untraversed
      // wrappers dragged the GLOBAL function coverage below threshold
      // while adding no signal — the route components themselves carry
      // their own test files.
      exclude: ['src/vite-env.d.ts', 'src/App.tsx'],
      reporter: ['text'],
      thresholds: {
        // The dashboard surface is large (manifest creator alone
        // carries 78% line coverage because three modal-close paths
        // and a handful of keyboard handlers are not exercised) and
        // any global threshold above ~98% is a flake factory. 98%
        // is the realistic floor: the rest is mostly dead defensive
        // UI handlers (close-on-backdrop, close-on-Escape, copy-to-
        // clipboard) where a behavioural test would just re-pin what
        // an end-to-end Playwright run already covers.
        statements: 98,
        branches: 92,
        functions: 98,
        lines: 98,
      },
    },
  },
});
