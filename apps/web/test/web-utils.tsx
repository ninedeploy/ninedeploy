import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';

import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, vi } from 'vitest';

/** RTL does not auto-cleanup without vitest `globals`, so register it here. */
afterEach(cleanup);

/** QueryClient with retries disabled so failing queries settle fast in tests. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

interface RenderWithProvidersOptions {
  route?: string;
  queryClient?: QueryClient;
  wrapper?: (children: ReactElement) => ReactElement;
}

/** Render `ui` inside QueryClientProvider + MemoryRouter (+ optional extra wrapper). */
export function renderWithProviders(ui: ReactElement, opts: RenderWithProvidersOptions = {}) {
  const queryClient = opts.queryClient ?? createQueryClient();
  const { route = '/', wrapper } = opts;
  let tree: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
  if (wrapper) tree = wrapper(tree);
  return { ...render(tree), queryClient };
}

/** A controllable WebSocket fake for testing code that opens sockets. */
export class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];

  url: string;
  protocols: string | string[] | undefined;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = '';
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  close = vi.fn();
  send = vi.fn();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  /** Simulate the server accepting the connection. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Simulate an inbound message from the server. */
  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Simulate a connection error. */
  error(): void {
    this.onerror?.();
  }

  /** Simulate the server closing the connection. */
  closeFromServer(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

/** A deferred promise so tests can hold a pending mutation/query in flight. */
export function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
