import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { ServiceDetail } from '@ninedeploy/sdk';
import { useFeaturesOn } from '../src/routes/service/SettingsFold.js';

const base = { id: 7, type: 'docker', serverId: null, orchestrator: 'compose', placement: undefined, runtimeOptions: null, canary: null } as unknown as ServiceDetail;

function on(svc: Partial<ServiceDetail>, cache: Array<[unknown[], unknown]> = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of cache) qc.setQueryData(key, data);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { ...renderHook(() => useFeaturesOn({ ...base, ...svc } as ServiceDetail), { wrapper }), qc };
}

describe('A3 settings fold: which features count as on', () => {
  it('folds everything for a plain service', () => {
    expect([...on({}).result.current]).toEqual([]);
  });

  it('reads the service fields', () => {
    const r = on({
      serverId: 3,
      orchestrator: 'swarm',
      placement: { buildOn: 'server', buildServerId: 2, pushRegistrySourceId: null, pushRepository: null } as never,
      runtimeOptions: { init: true } as never,
      canary: { steps: [10], stepSeconds: 60, maxErrorRate: 5, maxP95Ms: null, minRequests: 10 } as never,
    });
    expect([...r.result.current].sort()).toEqual(['buildPlacement', 'canary', 'containerOptions', 'orchestrator', 'target']);
  });

  it('treats empty runtime options, a default placement and a compose orchestrator as off', () => {
    const r = on({
      placement: { buildOn: 'target', buildServerId: null, pushRegistrySourceId: null, orchestrator: 'compose' } as never,
      runtimeOptions: { gpus: null, shmSizeMb: null, init: false, ulimitNofile: null, capAdd: [] } as never,
    });
    expect([...r.result.current]).toEqual([]);
  });

  it('reads the cached state of the cards that load their own', () => {
    const r = on({}, [
      [['maintenance', 7], { maintenance: { since: '2026-11-11T00:00:00Z' } }],
      [['restart-limit', 7], { limit: { maxRestarts: 5, windowMinutes: 10 } }],
      [['inline-dockerfile', 7], { content: 'FROM nginx' }],
      [['registry-hook', 7], { enabled: true }],
    ]);
    expect([...r.result.current].sort()).toEqual(['inlineDockerfile', 'maintenance', 'registryHook', 'restartLimit']);
  });

  it('counts custom error pages as maintenance being on, and follows the cache as it changes', async () => {
    const r = on({}, [[['maintenance', 7], { maintenance: null }], [['error-pages', 7], { pages: {} }]]);
    expect(r.result.current.has('maintenance')).toBe(false);
    r.qc.setQueryData(['error-pages', 7], { pages: { 502: '<h1>down</h1>' } });
    await waitFor(() => expect(r.result.current.has('maintenance')).toBe(true));
  });

  it('never fetches: it only watches what the cards load', () => {
    const r = on({});
    expect(r.qc.getQueryCache().getAll().every((q) => q.state.fetchStatus === 'idle')).toBe(true);
  });
});
