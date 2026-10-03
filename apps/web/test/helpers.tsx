import { afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { InitialEntry } from 'react-router';
import type { ReactNode } from 'react';
import { AuthProvider } from '../src/lib/auth.js';
import { ToastProvider } from '../src/components/Toast.js';
import { ProjectScopeProvider } from '../src/lib/projects.js';
import { WorkspaceProvider } from '../src/lib/workspace.js';

/** jsdom does not implement ResizeObserver — some rendered components touch it. */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Build the fake module shape consumed by `src/lib/api.ts` consumers:
 * an `api` client where every method is a controllable `vi.fn()` plus the
 * token helpers routes import. Returned object mirrors the module exports.
 */

// Re-exported so `import { createFakeApiModule } from './helpers.js'` still
// works at TEST time. Inside a vi.mock factory, import './apiMock.js' directly
// — see the note in that file.
export { createFakeApiModule } from './apiMock.js';

export { createAuthMock, createThemeMock, createWorkspaceMock } from './apiMock.js';

/** Options for the render helpers below. */
interface RenderOptions {
  route?: string;
  /** MemoryRouter accepts plain paths and partial locations (with state). */
  initialEntries?: InitialEntry[];
}

/**
 * Render a route element inside the providers every route needs:
 * react-query (no retries), a router, and a toaster.
 */
export function renderWithProviders(ui: ReactNode, opts: RenderOptions = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const initialEntries = opts.initialEntries ?? [opts.route ?? '/'];
  const utils = render(
    <QueryClientProvider client={queryClient}>
      {/* WorkspaceProvider calls useAuth, so the auth context has to exist.
          With `lib/api.js` mocked, AuthProvider does no network work: getToken()
          returns undefined and it settles immediately with user = null. Tests
          that need a signed-in user mock `lib/auth.js` themselves, and their
          AuthProvider stub simply passes children through. */}
      <AuthProvider>
        <WorkspaceProvider>
          <ProjectScopeProvider>
            {/* No TagScopeProvider here on purpose: it fetches its own
                projects/labels/workspaces, which would shift the first raw
                `fetch` call every export/import test asserts on. Routes fall
                back to the unfiltered scope; the tests that exercise chip
                filtering wrap their subject in TagScopeProvider themselves. */}
            <MemoryRouter initialEntries={initialEntries}>
              <ToastProvider>{ui}</ToastProvider>
            </MemoryRouter>
          </ProjectScopeProvider>
        </WorkspaceProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

/**
 * Render a route component that relies on `useParams`, mounted under a
 * matching <Route> so the params are populated.
 */
export function renderRoute(ui: ReactNode, opts: RenderOptions & { path: string }) {
  const { path, ...rest } = opts;
  return renderWithProviders(
    <Routes>
      <Route path={path} element={ui} />
    </Routes>,
    rest,
  );
}

/** Convenience: cast an api mock method to its vi.fn for per-test setup. */
export function mockOf(fn: unknown) {
  return fn as ReturnType<typeof vi.fn>;
}
