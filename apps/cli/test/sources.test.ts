import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourcesAdd, sourcesKeygen, sourcesList, sourcesRemove, sourcesShow, sourcesTest } from '../src/commands/sources.js';

const h = vi.hoisted(() => ({
  prompt: vi.fn(),
  promptHidden: vi.fn(),
}));

vi.mock('../src/prompts.js', () => ({ prompt: h.prompt, promptHidden: h.promptHidden }));

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    sources: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      test: vi.fn(),
      ...(overrides['sources'] as Record<string, unknown> | undefined),
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
  // Default to "empty string" so the interactive loop bails out at the first
  // "would you like to continue" prompt.
  h.prompt.mockResolvedValue('');
  h.promptHidden.mockResolvedValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sourcesList', () => {
  it('prints a hint when there are no sources', async () => {
    const list = vi.fn().mockResolvedValue([]);
    await sourcesList(makeClient({ sources: { list } }));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No sources yet'));
  });

  it('prints a table of sources with token/key presence', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 1, name: 'gh', type: 'github', hasToken: true, hasDeployKey: false, defaultBranch: 'main' },
      { id: 2, name: 'gl', type: 'gitlab', hasToken: false, hasDeployKey: true, defaultBranch: 'dev' },
    ]);
    await sourcesList(makeClient({ sources: { list } }));
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('gh');
    expect(out).toContain('gitlab');
  });

  it('falls back to "main" when defaultBranch is null', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 1, name: 'gh', type: 'github', hasToken: true, hasDeployKey: false, defaultBranch: null },
    ]);
    await sourcesList(makeClient({ sources: { list } }));
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('main');
  });
});

describe('sourcesAdd', () => {
  it('rejects when the provider is unknown', async () => {
    h.prompt
      .mockResolvedValueOnce('my-src') // name
      .mockResolvedValueOnce('oracle'); // provider
    await sourcesAdd(makeClient(), 'my-src');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown provider'));
  });

  it('creates a GitHub token source from a name arg and env-provided token', async () => {
    const create = vi.fn().mockResolvedValue({ id: 7, name: 'gh' });
    const test = vi.fn().mockResolvedValue({ ok: true, provider: 'github', login: 'me', name: 'Me' });
    h.prompt
      .mockResolvedValueOnce('github') // provider
      .mockResolvedValueOnce('main') // default branch
      .mockResolvedValueOnce('token'); // auth kind
    const prev = process.env['NINEDEPLOY_GITHUB_TOKEN'];
    process.env['NINEDEPLOY_GITHUB_TOKEN'] = 'ghp_env';
    try {
      await sourcesAdd(makeClient({ sources: { create, test } }), 'gh');
    } finally {
      if (prev === undefined) delete process.env['NINEDEPLOY_GITHUB_TOKEN'];
      else process.env['NINEDEPLOY_GITHUB_TOKEN'] = prev;
    }
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'gh', type: 'github', token: 'ghp_env' }));
    expect(test).toHaveBeenCalledWith(7);
  });

  it('falls back to the masked prompt when no env var is set', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'gl' });
    const test = vi.fn().mockResolvedValue({ ok: false, error: 'nope' });
    h.prompt
      .mockResolvedValueOnce('gitlab') // provider
      .mockResolvedValueOnce('main') // default branch
      .mockResolvedValueOnce('token'); // auth kind
    h.promptHidden.mockResolvedValueOnce('glpat_typed');
    const prev = process.env['NINEDEPLOY_GITLAB_TOKEN'];
    delete process.env['NINEDEPLOY_GITLAB_TOKEN'];
    try {
      await sourcesAdd(makeClient({ sources: { create, test } }), 'gl');
    } finally {
      if (prev !== undefined) process.env['NINEDEPLOY_GITLAB_TOKEN'] = prev;
    }
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'gl', type: 'gitlab', token: 'glpat_typed' }));
  });

  it('skips the live test for sources other than github/gitlab', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'reg' });
    const test = vi.fn();
    h.prompt
      .mockResolvedValueOnce('registry') // provider
      .mockResolvedValueOnce('main') // default branch
      .mockResolvedValueOnce('ci-bot'); // username
    h.promptHidden.mockResolvedValueOnce('regpass');
    await sourcesAdd(makeClient({ sources: { create, test } }), 'reg');
    // Registry sources do not get a live credential test (the test endpoint
    // only knows github + gitlab today). Make sure that contract holds.
    expect(test).not.toHaveBeenCalled();
  });

  it('creates a GitHub SSH deploy-key source from $NINEDEPLOY_SSH_KEY', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'gh-ssh' });
    const test = vi.fn();
    h.prompt
      .mockResolvedValueOnce('github') // provider
      .mockResolvedValueOnce('main') // default branch
      .mockResolvedValueOnce('ssh'); // auth kind
    const prev = process.env['NINEDEPLOY_SSH_KEY'];
    process.env['NINEDEPLOY_SSH_KEY'] = 'env-ssh-key';
    try {
      await sourcesAdd(makeClient({ sources: { create, test } }), 'gh-ssh');
    } finally {
      if (prev === undefined) delete process.env['NINEDEPLOY_SSH_KEY'];
      else process.env['NINEDEPLOY_SSH_KEY'] = prev;
    }
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'github', deployKey: 'env-ssh-key' }));
  });

  it('registers a custom source with an SSH key', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'self' });
    h.prompt
      .mockResolvedValueOnce('custom') // provider
      .mockResolvedValueOnce('main') // default branch
      .mockResolvedValueOnce('ssh'); // auth kind
    h.promptHidden.mockResolvedValueOnce('-----BEGIN KEY-----…');
    delete process.env['NINEDEPLOY_SSH_KEY'];
    await sourcesAdd(makeClient({ sources: { create, test: vi.fn() } }), 'self');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'self', type: 'custom', deployKey: expect.stringMatching(/KEY/) }));
  });

  it('registers a custom source with a token', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'self' });
    h.prompt
      .mockResolvedValueOnce('custom') // provider
      .mockResolvedValueOnce('main') // default branch
      .mockResolvedValueOnce('token'); // auth kind
    h.promptHidden.mockResolvedValueOnce('custom_token');
    delete process.env['NINEDEPLOY_TOKEN'];
    await sourcesAdd(makeClient({ sources: { create, test: vi.fn() } }), 'self');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'self', type: 'custom', token: 'custom_token' }));
  });

  it('registers a gitea token source (no live test call)', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'gt' });
    h.prompt
      .mockResolvedValueOnce('gitea') // provider
      .mockResolvedValueOnce('main'); // default branch
    h.promptHidden.mockResolvedValueOnce('gtoken');
    await sourcesAdd(makeClient({ sources: { create, test: vi.fn() } }), 'gt');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'gitea', token: 'gtoken' }));
  });

  it('registers a registry source with username', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'reg' });
    h.prompt
      .mockResolvedValueOnce('registry') // provider
      .mockResolvedValueOnce('main') // default branch
      .mockResolvedValueOnce('ci-bot'); // username
    h.promptHidden.mockResolvedValueOnce('regpass');
    await sourcesAdd(makeClient({ sources: { create, test: vi.fn() } }), 'reg');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'registry', registryUsername: 'ci-bot', token: 'regpass' }));
  });

  it('rejects when no credential was provided', async () => {
    h.prompt
      .mockResolvedValueOnce('gitea') // provider
      .mockResolvedValueOnce('main'); // default branch
    h.promptHidden.mockResolvedValueOnce('');
    await sourcesAdd(makeClient({ sources: { create: vi.fn(), test: vi.fn() } }), 'gt');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('token or an SSH deploy key'));
  });

  it('rejects when no name is provided and no arg is given', async () => {
    h.prompt.mockResolvedValueOnce(''); // name prompt returns empty
    await sourcesAdd(makeClient({ sources: { create: vi.fn(), test: vi.fn() } }));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Name is required'));
  });

  it('surfaces the API error when create throws', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db is locked'));
    h.prompt
      .mockResolvedValueOnce('gitea') // provider
      .mockResolvedValueOnce('main'); // default branch
    h.promptHidden.mockResolvedValueOnce('gtoken');
    await sourcesAdd(makeClient({ sources: { create, test: vi.fn() } }), 'gt');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('db is locked'));
  });

  it('falls back to "main" when the default branch prompt returns empty', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'gt' });
    h.prompt
      .mockResolvedValueOnce('gitea') // provider
      .mockResolvedValueOnce(''); // empty default branch — should fall back to "main"
    h.promptHidden.mockResolvedValueOnce('gtoken');
    await sourcesAdd(makeClient({ sources: { create, test: vi.fn() } }), 'gt');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ defaultBranch: 'main' }));
  });

  it('skips registryUsername when the prompt returns empty', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'reg' });
    h.prompt
      .mockResolvedValueOnce('registry') // provider
      .mockResolvedValueOnce('main') // default branch
      .mockResolvedValueOnce(''); // empty username
    h.promptHidden.mockResolvedValueOnce('regpass');
    await sourcesAdd(makeClient({ sources: { create, test: vi.fn() } }), 'reg');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'registry', registryUsername: undefined }));
  });
});

describe('sourcesTest', () => {
  it('prints a success message when the credential is good', async () => {
    const test = vi.fn().mockResolvedValue({ ok: true, provider: 'github', login: 'me', name: 'Me' });
    await sourcesTest(makeClient({ sources: { test } }), '5');
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('me');
    expect(out).toContain('Me');
  });

  it('prints an error when the credential is bad', async () => {
    const test = vi.fn().mockResolvedValue({ ok: false, provider: 'github', status: 401, error: 'Bad credentials' });
    await sourcesTest(makeClient({ sources: { test } }), '5');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Bad credentials'));
  });

  it('prompts for a source id when none is given and a list is available', async () => {
    const list = vi.fn().mockResolvedValue([{ id: 9, name: 'gh', type: 'github' }]);
    const test = vi.fn().mockResolvedValue({ ok: true, provider: 'github', login: 'me' });
    h.prompt.mockResolvedValueOnce('9');
    await sourcesTest(makeClient({ sources: { list, test } }));
    expect(test).toHaveBeenCalledWith(9);
  });

  it('informs the user when there are no sources to pick from', async () => {
    const list = vi.fn().mockResolvedValue([]);
    await sourcesTest(makeClient({ sources: { list } }));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No sources yet'));
  });

  it('rejects a non-numeric id when one is supplied', async () => {
    h.prompt.mockReset();
    // First prompt: source list (empty), second: any number, third: confirm
    const list = vi.fn().mockResolvedValue([{ id: 1, name: 'a', type: 'github', hasToken: true, hasDeployKey: false, defaultBranch: 'main' }]);
    h.prompt.mockResolvedValueOnce('not-a-number'); // user typed a junk id
    await sourcesTest(makeClient({ sources: { list } }));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('numeric source id'));
  });

  it('falls back to "unknown error" when the API does not return one', async () => {
    const test = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await sourcesTest(makeClient({ sources: { test } }), '5');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unknown error'));
  });
});

describe('sourcesRemove', () => {
  it('removes the source after the user types "delete"', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    h.prompt.mockResolvedValueOnce('delete');
    await sourcesRemove(makeClient({ sources: { remove } }), '4');
    expect(remove).toHaveBeenCalledWith(4);
  });

  it('aborts when the confirmation does not match', async () => {
    const remove = vi.fn();
    h.prompt.mockResolvedValueOnce('no');
    await sourcesRemove(makeClient({ sources: { remove } }), '4');
    expect(remove).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Aborted'));
  });

  it('falls back to prompting the user for an id when no arg is given', async () => {
    const list = vi.fn().mockResolvedValue([{ id: 9, name: 'gh', type: 'github' }]);
    const remove = vi.fn().mockResolvedValue(undefined);
    h.prompt.mockResolvedValueOnce('9').mockResolvedValueOnce('delete');
    await sourcesRemove(makeClient({ sources: { list, remove } }));
    expect(remove).toHaveBeenCalledWith(9);
  });

  it('rejects a non-numeric id from the picker', async () => {
    const list = vi.fn().mockResolvedValue([{ id: 9, name: 'gh', type: 'github' }]);
    h.prompt.mockResolvedValueOnce('not-a-number');
    await sourcesRemove(makeClient({ sources: { list, remove: vi.fn() } }));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('numeric source id is required'));
  });

  it('prints a hint when there are no sources to remove', async () => {
    const list = vi.fn().mockResolvedValue([]);
    await sourcesRemove(makeClient({ sources: { list } }));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No sources to remove'));
  });

  it('surfaces the API error when remove throws', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('forbidden'));
    h.prompt.mockResolvedValueOnce('delete');
    await sourcesRemove(makeClient({ sources: { remove } }), '4');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('forbidden'));
  });
});

describe('sourcesShow', () => {
  it('prints all fields of the source', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 4, name: 'gh', type: 'github', hasToken: true, hasDeployKey: false, registryUsername: null, defaultBranch: 'main', createdAt: '2026-01-01', updatedAt: '2026-02-01' },
    ]);
    await sourcesShow(makeClient({ sources: { list } }), '4');
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('gh');
    expect(out).toContain('main');
  });

  it('prints a 404-style error when the source is missing', async () => {
    const list = vi.fn().mockResolvedValue([{ id: 1, name: 'other', type: 'github', hasToken: true, hasDeployKey: false, defaultBranch: 'main' }]);
    await sourcesShow(makeClient({ sources: { list } }), '999');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('requires a numeric id', async () => {
    await sourcesShow(makeClient({ sources: { list: vi.fn() } }), 'not-a-number');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('shows deploy-key + null branch + registry username (alternate shapes)', async () => {
    const list = vi.fn().mockResolvedValue([
      { id: 4, name: 'gl', type: 'gitlab', hasToken: false, hasDeployKey: true, registryUsername: 'ci', defaultBranch: null, createdAt: '2026-01-01', updatedAt: '2026-02-01' },
    ]);
    await sourcesShow(makeClient({ sources: { list } }), '4');
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('ci');
    expect(out).toContain('main'); // fallback when defaultBranch is null
  });
});

describe('sourcesKeygen', () => {
  it('prints the public key + fingerprint when the id is supplied', async () => {
    const generateDeployKey = vi.fn().mockResolvedValue({
      publicKey: 'ssh-ed25519 AAAA-fake-key ninedeploy@github-personal',
      fingerprint: 'SHA256:abc123',
    });
    await sourcesKeygen(makeClient({ sources: { generateDeployKey } }), '7');
    expect(generateDeployKey).toHaveBeenCalledWith(7);
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('AAAA-fake-key');
    expect(out).toContain('SHA256:abc123');
  });

  it('prompts for a source id when no arg is given', async () => {
    const list = vi.fn().mockResolvedValue([{ id: 3, name: 'gh', type: 'github' }]);
    const generateDeployKey = vi.fn().mockResolvedValue({
      publicKey: 'ssh-ed25519 AAAA ninedeploy@gh',
      fingerprint: 'SHA256:zzz',
    });
    h.prompt.mockResolvedValueOnce('3');
    await sourcesKeygen(makeClient({ sources: { list, generateDeployKey } }));
    expect(generateDeployKey).toHaveBeenCalledWith(3);
  });

  it('prints a hint when there are no sources to pick from', async () => {
    const list = vi.fn().mockResolvedValue([]);
    const generateDeployKey = vi.fn();
    await sourcesKeygen(makeClient({ sources: { list, generateDeployKey } }));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No sources yet'));
    expect(generateDeployKey).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric id from the picker', async () => {
    const list = vi.fn().mockResolvedValue([{ id: 1, name: 'gh', type: 'github' }]);
    h.prompt.mockResolvedValueOnce('not-a-number');
    await sourcesKeygen(makeClient({ sources: { list, generateDeployKey: vi.fn() } }));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('numeric source id is required'));
  });
});
