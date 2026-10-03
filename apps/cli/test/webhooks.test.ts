import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webhooksAdd, webhooksList, webhooksRemove, webhooksShow } from '../src/commands/webhooks.js';

const h = vi.hoisted(() => ({ prompt: vi.fn() }));

vi.mock('../src/prompts.js', () => ({ prompt: h.prompt }));

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    webhooks: {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      ...(overrides['webhooks'] as Record<string, unknown> | undefined),
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
  h.prompt.mockResolvedValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('webhooksList', () => {
  it('prints a hint when no webhooks are configured', async () => {
    const list = vi.fn().mockResolvedValue([]);
    await webhooksList(makeClient({ webhooks: { list } }), '1');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No webhooks yet'));
  });

  it('prints a table of webhooks with source id and URL', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 3, branch: 'main', active: true, sourceId: 1, url: 'https://panel.example/v1/hooks/3', createdAt: '2026-01-01' },
    ]);
    await webhooksList(makeClient({ webhooks: { list } }), '1');
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('https://panel.example/v1/hooks/3');
  });

  it('rejects a non-numeric service id', async () => {
    await webhooksList(makeClient({ webhooks: { list: vi.fn() } }), 'oops');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('renders both inherited-source and inactive rows in the table', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 3, branch: 'main', active: false, sourceId: null, url: 'https://x/v1/hooks/3', createdAt: '2026-01-01' },
    ]);
    await webhooksList(makeClient({ webhooks: { list } }), '1');
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('—'); // source fallback marker
  });
});

describe('webhooksAdd', () => {
  it('creates a webhook with the service default branch when no arg is given', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 9,
      branch: 'main',
      active: true,
      sourceId: 1,
      url: 'https://panel.example/v1/hooks/9',
      secret: 's3cr3t',
    });
    // Mock the real `prompt` default-handling: empty user input ⇒ "main" default.
    h.prompt
      .mockImplementationOnce(async (_msg: string, defaultValue?: string) => defaultValue ?? '')
      .mockResolvedValueOnce(''); // watch paths
    await webhooksAdd(makeClient({ webhooks: { create } }), '42');
    expect(create).toHaveBeenCalledWith(42, expect.objectContaining({ branch: 'main' }));
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('s3cr3t');
    expect(out).toContain('https://panel.example/v1/hooks/9');
  });

  it('uses the explicit branch arg and includes the watch paths prompt answer', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 10, branch: 'release', active: true, sourceId: null,
      url: 'https://panel.example/v1/hooks/10', secret: 'zzz',
    });
    h.prompt.mockResolvedValueOnce('apps/api/**\npackages/**');
    await webhooksAdd(makeClient({ webhooks: { create } }), '7', 'release');
    expect(create).toHaveBeenCalledWith(7, expect.objectContaining({ branch: 'release', watchPaths: 'apps/api/**\npackages/**' }));
  });

  it('requires a numeric service id', async () => {
    await webhooksAdd(makeClient({ webhooks: { create: vi.fn() } }), 'not-a-number');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('requires a branch when the prompt returns empty and no arg is given', async () => {
    // Both the branch and watchPaths prompts return '' — the watchPaths one
    // short-circuits to undefined but the branch is the one that aborts.
    h.prompt.mockImplementation(async (_msg: string, defaultValue?: string) => defaultValue ?? '');
    // Make the branch prompt refuse to default to "main" by stubbing prompt
    // to return '' unconditionally for the branch question.
    h.prompt.mockReset();
    h.prompt.mockResolvedValueOnce(''); // branch = empty
    await webhooksAdd(makeClient({ webhooks: { create: vi.fn() } }), '42');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Branch is required'));
  });
});

describe('webhooksRemove', () => {
  it('removes when the user types "delete"', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    h.prompt.mockResolvedValueOnce('delete');
    await webhooksRemove(makeClient({ webhooks: { remove } }), '7', '9');
    expect(remove).toHaveBeenCalledWith(7, 9);
  });

  it('aborts when the confirmation is wrong', async () => {
    const remove = vi.fn();
    h.prompt.mockResolvedValueOnce('nope');
    await webhooksRemove(makeClient({ webhooks: { remove } }), '7', '9');
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects missing numeric ids', async () => {
    await webhooksRemove(makeClient({ webhooks: { remove: vi.fn() } }), 'abc', '9');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });
});

describe('webhooksShow', () => {
  it('prints all fields when the webhook exists', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 9, branch: 'main', active: true, sourceId: 1, watchPaths: '', url: 'https://x/v1/hooks/9', createdAt: '2026-01-01' },
    ]);
    await webhooksShow(makeClient({ webhooks: { list } }), '7', '9');
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('https://x/v1/hooks/9');
  });

  it('prints an error when the webhook is not found', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 9, branch: 'main', active: true, sourceId: 1, watchPaths: '', url: 'https://x/v1/hooks/9', createdAt: '2026-01-01' },
    ]);
    await webhooksShow(makeClient({ webhooks: { list } }), '7', '99');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('rejects missing numeric ids', async () => {
    await webhooksShow(makeClient({ webhooks: { list: vi.fn() } }), 'abc', '9');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('prints the "inherits service default" hint when sourceId is null', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 9, branch: 'main', active: true, sourceId: null, watchPaths: 'apps/**', url: 'https://x/v1/hooks/9', createdAt: '2026-01-01' },
    ]);
    await webhooksShow(makeClient({ webhooks: { list } }), '7', '9');
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('inherits service default');
  });

  it('marks the row inactive when active=false', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 9, branch: 'main', active: false, sourceId: 1, watchPaths: '', url: 'https://x/v1/hooks/9', createdAt: '2026-01-01' },
    ]);
    await webhooksShow(makeClient({ webhooks: { list } }), '7', '9');
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('no');
  });
});
