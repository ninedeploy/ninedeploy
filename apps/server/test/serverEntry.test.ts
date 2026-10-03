import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildApp: vi.fn(async () => ({ addHook: vi.fn(), listen: vi.fn(async () => undefined), log: { info: vi.fn(), error: vi.fn() }, close: vi.fn() })),
  agentLoaded: vi.fn(),
}));
vi.mock('../src/app.js', () => ({ buildApp: mocks.buildApp }));
vi.mock('../src/agent.js', () => {
  mocks.agentLoaded();
  return {};
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  mocks.buildApp.mockClear();
  mocks.agentLoaded.mockClear();
});

describe('r175: the image entrypoint honours NINEDEPLOY_AGENT', () => {
  it('runs the agent and never boots a panel on a node', async () => {
    vi.stubEnv('NINEDEPLOY_AGENT', '1');
    await import('../src/server.js');
    await vi.waitFor(() => expect(mocks.agentLoaded).toHaveBeenCalled());
    expect(mocks.buildApp).not.toHaveBeenCalled();
  });
});
