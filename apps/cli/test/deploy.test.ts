import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployFromGithub } from '../src/commands/deploy.js';

const h = vi.hoisted(() => ({
  prompt: vi.fn(),
  promptHidden: vi.fn(),
  webhooksAdd: vi.fn(),
}));

vi.mock('../src/prompts.js', () => ({ prompt: h.prompt, promptHidden: h.promptHidden }));
vi.mock('../src/commands/webhooks.js', () => ({ webhooksAdd: h.webhooksAdd }));

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    sources: { list: vi.fn(), create: vi.fn() },
    insights: { analyze: vi.fn() },
    services: { create: vi.fn() },
    env: { create: vi.fn() },
    deploys: { trigger: vi.fn() },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
  h.prompt.mockResolvedValue('');
  h.promptHidden.mockResolvedValue('');
  h.webhooksAdd.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deployFromGithub', () => {
  it('rejects an ssh:// url (https only in this command)', async () => {
    await deployFromGithub(makeClient(), 'git@github.com:owner/app.git');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('https://'));
  });

  it('rejects when no URL is given and the prompt returns empty', async () => {
    await deployFromGithub(makeClient());
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Repository URL is required'));
  });

  it('rejects a private repo with no matching token when no env is set and the prompt is empty', async () => {
    h.promptHidden.mockResolvedValueOnce(''); // no token
    delete process.env['NINEDEPLOY_GITHUB_TOKEN'];
    const sources = { list: vi.fn().mockResolvedValue([]) };
    await deployFromGithub(makeClient({ sources }), 'https://github.com/owner/app');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('token is required'));
  });

  it('uses an existing matching source (single candidate) and finishes end-to-end', async () => {
    const sources = { list: vi.fn().mockResolvedValue([{ id: 1, name: 'gh', type: 'github', hasToken: true, defaultBranch: 'main' }]) };
    const insights = { analyze: vi.fn().mockResolvedValue({
      framework: { name: 'Next.js', category: 'ssr', port: 3000, installCmd: 'npm ci', buildCmd: 'npm run build', startCmd: 'npm start', env: [], notes: [] },
      language: 'TypeScript', nodeVersion: '22', packageManager: 'npm', frameworkVersion: '14',
      scripts: {}, dependencyCount: 1, devDependencyCount: 1, hasDockerfile: false, hasComposeFile: false, monorepo: false,
      detectedFiles: [], workspacePackages: [], baseDir: '.', commitSha: null, analyzedAt: '2026-01-01T00:00:00.000Z',
    }) };
    const create = vi.fn().mockResolvedValue({ id: 42, name: 'app' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 99 });
    h.prompt
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('app') // name
      .mockResolvedValueOnce('n') // override commands
      .mockResolvedValueOnce(''); // env loop: empty key ends it
    await deployFromGithub(makeClient({ sources, insights: { analyze: insights.analyze }, services: { create }, deploys: { trigger } }), 'https://github.com/owner/app');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ repoUrl: 'https://github.com/owner/app', sourceId: 1, type: 'docker' }));
    expect(trigger).toHaveBeenCalledWith(42);
  });

  it('prompts the user to pick when multiple sources match', async () => {
    const sources = { list: vi.fn().mockResolvedValue([
      { id: 1, name: 'gh1', type: 'github', hasToken: true, defaultBranch: 'main' },
      { id: 2, name: 'gh2', type: 'github', hasToken: true, defaultBranch: 'main' },
    ]) };
    const insights = { analyze: vi.fn().mockResolvedValue(null) };
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'x' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 1 });
    h.prompt
      .mockResolvedValueOnce('1') // pick source
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // name (use default)
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('/') // health path
      .mockResolvedValueOnce('n') // override commands
      .mockResolvedValueOnce('') // env loop end
      .mockResolvedValueOnce('n') // skip deploy
      .mockResolvedValueOnce('n'); // skip webhook
    await deployFromGithub(makeClient({ sources, insights, services: { create }, deploys: { trigger } }), 'https://github.com/owner/app');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 1 }));
  });

  it('creates a source inline when none exists and the env var is set', async () => {
    const sources = { list: vi.fn().mockResolvedValue([]) };
    const sourcesCreate = vi.fn().mockResolvedValue({ id: 7, name: 'gh-new', type: 'github' });
    const insights = { analyze: vi.fn().mockResolvedValue(null) };
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'x' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 1 });
    h.prompt
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // name (default from url)
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('/') // health path
      .mockResolvedValueOnce('n') // override
      .mockResolvedValueOnce('') // env loop
      .mockResolvedValueOnce('n') // skip deploy
      .mockResolvedValueOnce('n'); // skip webhook
    process.env['NINEDEPLOY_GITHUB_TOKEN'] = 'ghp_inline';
    try {
      await deployFromGithub(makeClient({ sources: { list: sources.list, create: sourcesCreate }, insights, services: { create }, deploys: { trigger } }), 'https://github.com/owner/app');
    } finally {
      delete process.env['NINEDEPLOY_GITHUB_TOKEN'];
    }
    expect(sourcesCreate).toHaveBeenCalledWith(expect.objectContaining({ token: 'ghp_inline' }));
  });

  it('falls back to the masked prompt when no env var is set (inline source create)', async () => {
    const sources = { list: vi.fn().mockResolvedValue([]) };
    const sourcesCreate = vi.fn().mockResolvedValue({ id: 7, name: 'gh-new', type: 'github' });
    const insights = { analyze: vi.fn().mockResolvedValue(null) };
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'x' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 1 });
    h.prompt
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // name (default from url)
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('/') // health path
      .mockResolvedValueOnce('n') // override
      .mockResolvedValueOnce('') // env loop
      .mockResolvedValueOnce('n') // skip deploy
      .mockResolvedValueOnce('n'); // skip webhook
    h.promptHidden.mockResolvedValueOnce('ghp_typed');
    delete process.env['NINEDEPLOY_GITHUB_TOKEN'];
    await deployFromGithub(makeClient({ sources: { list: sources.list, create: sourcesCreate }, insights, services: { create }, deploys: { trigger } }), 'https://github.com/owner/app');
    expect(sourcesCreate).toHaveBeenCalledWith(expect.objectContaining({ token: 'ghp_typed' }));
  });

  it('handles a non-github host by letting the user pick any existing source', async () => {
    const sources = { list: vi.fn().mockResolvedValue([{ id: 4, name: 'self', type: 'custom', hasToken: true, defaultBranch: 'main' }]) };
    const insights = { analyze: vi.fn().mockResolvedValue(null) };
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'x' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 1 });
    h.prompt
      .mockResolvedValueOnce('4') // source
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // name
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('/') // health path
      .mockResolvedValueOnce('n') // override
      .mockResolvedValueOnce('') // env loop
      .mockResolvedValueOnce('n') // skip deploy
      .mockResolvedValueOnce('n'); // skip webhook
    await deployFromGithub(makeClient({ sources, insights, services: { create }, deploys: { trigger } }), 'https://git.example.com/owner/app');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 4 }));
  });

  it('rejects when there are no sources at all and the host is unknown', async () => {
    const sources = { list: vi.fn().mockResolvedValue([]) };
    await deployFromGithub(makeClient({ sources }), 'https://git.example.com/owner/app');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No sources configured'));
  });

  it('lets the user override install/build/start commands', async () => {
    const sources = { list: vi.fn().mockResolvedValue([{ id: 1, name: 'gh', type: 'github', hasToken: true, defaultBranch: 'main' }]) };
    const insights = { analyze: vi.fn().mockResolvedValue(null) };
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'x' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 1 });
    const envCreate = vi.fn().mockResolvedValue({});
    h.prompt
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // name
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('/') // health path
      .mockResolvedValueOnce('y') // override
      .mockResolvedValueOnce('pnpm install --frozen-lockfile') // install
      .mockResolvedValueOnce('pnpm build') // build
      .mockResolvedValueOnce('pnpm start') // start
      .mockResolvedValueOnce('NODE_ENV') // env key
      .mockResolvedValueOnce('production') // env value
      .mockResolvedValueOnce('y') // env is secret
      .mockResolvedValueOnce('') // env loop end
      .mockResolvedValueOnce('n') // skip deploy
      .mockResolvedValueOnce('n'); // skip webhook
    await deployFromGithub(
      makeClient({ sources, insights, services: { create }, deploys: { trigger }, env: { create: envCreate } }),
      'https://github.com/owner/app',
    );
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ build: expect.objectContaining({ installCmd: 'pnpm install --frozen-lockfile', startCmd: 'pnpm start' }) }));
    expect(envCreate).toHaveBeenCalledWith(1, expect.objectContaining({ key: 'NODE_ENV', value: 'production', isSecret: true }));
  });

  it('wires up a webhook when the user says yes', async () => {
    const sources = { list: vi.fn().mockResolvedValue([{ id: 1, name: 'gh', type: 'github', hasToken: true, defaultBranch: 'main' }]) };
    const insights = { analyze: vi.fn().mockResolvedValue(null) };
    const create = vi.fn().mockResolvedValue({ id: 11, name: 'x' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 22 });
    h.prompt
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // name
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('/') // health path
      .mockResolvedValueOnce('n') // override
      .mockResolvedValueOnce('') // env loop
      .mockResolvedValueOnce('n') // skip deploy
      .mockResolvedValueOnce('y'); // do webhook
    await deployFromGithub(makeClient({ sources, insights, services: { create }, deploys: { trigger } }), 'https://github.com/owner/app');
    expect(h.webhooksAdd).toHaveBeenCalledWith(expect.anything(), '11', 'main');
  });

  it('falls back to a different-type token-bearing source if none matches the host', async () => {
    // URL is github.com but the only token-bearing source is gitlab — the user
    // must explicitly pick it (different providers are not auto-matched).
    const sources = { list: vi.fn().mockResolvedValue([
      { id: 5, name: 'gl', type: 'gitlab', hasToken: true, defaultBranch: 'main' },
    ]) };
    const insights = { analyze: vi.fn().mockResolvedValue(null) };
    const create = vi.fn().mockResolvedValue({ id: 9, name: 'x' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 1 });
    h.prompt
      .mockResolvedValueOnce('5') // source id
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // name
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('/') // health path
      .mockResolvedValueOnce('n') // override
      .mockResolvedValueOnce('') // env loop
      .mockResolvedValueOnce('n') // skip deploy
      .mockResolvedValueOnce('n'); // skip webhook
    await deployFromGithub(makeClient({ sources, insights, services: { create }, deploys: { trigger } }), 'https://github.com/owner/app');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 5 }));
  });

  it('rejects an invalid container port', async () => {
    const sources = { list: vi.fn().mockResolvedValue([{ id: 1, name: 'gh', type: 'github', hasToken: true, defaultBranch: 'main' }]) };
    const insights = { analyze: vi.fn().mockResolvedValue(null) };
    h.prompt
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // name
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('not-a-port'); // port
    await deployFromGithub(makeClient({ sources, insights }), 'https://github.com/owner/app');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Port must be'));
  });

  it('rejects a non-github host with no sources at all', async () => {
    const sources = { list: vi.fn().mockResolvedValue([]) };
    await deployFromGithub(makeClient({ sources }), 'https://git.example.com/owner/app');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No sources configured'));
  });

  it('warns and continues when the framework analysis throws', async () => {
    const sources = { list: vi.fn().mockResolvedValue([{ id: 1, name: 'gh', type: 'github', hasToken: true, defaultBranch: 'main' }]) };
    const insights = { analyze: vi.fn().mockRejectedValue(new Error('clone failed')) };
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'x' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 1 });
    h.prompt
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // name
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('/') // health path
      .mockResolvedValueOnce('n') // override
      .mockResolvedValueOnce('') // env loop
      .mockResolvedValueOnce('n') // skip deploy
      .mockResolvedValueOnce('n'); // skip webhook
    await deployFromGithub(makeClient({ sources, insights, services: { create }, deploys: { trigger } }), 'https://github.com/owner/app');
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('Repo analysis failed');
  });

  it('warns when a single env var setter throws and keeps going', async () => {
    const sources = { list: vi.fn().mockResolvedValue([{ id: 1, name: 'gh', type: 'github', hasToken: true, defaultBranch: 'main' }]) };
    const insights = { analyze: vi.fn().mockResolvedValue(null) };
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'x' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 1 });
    const envCreate = vi.fn().mockRejectedValueOnce(new Error('quota exceeded'));
    h.prompt
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // name
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('/') // health path
      .mockResolvedValueOnce('n') // override
      .mockResolvedValueOnce('FOO') // env key
      .mockResolvedValueOnce('bar') // env value
      .mockResolvedValueOnce('n') // env is NOT secret
      .mockResolvedValueOnce('') // env loop end
      .mockResolvedValueOnce('n') // skip deploy
      .mockResolvedValueOnce('n'); // skip webhook
    await deployFromGithub(makeClient({ sources, insights, services: { create }, deploys: { trigger }, env: { create: envCreate } }), 'https://github.com/owner/app');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('quota exceeded'));
  });

  it('prints framework notes when the analysis reports any', async () => {
    const sources = { list: vi.fn().mockResolvedValue([{ id: 1, name: 'gh', type: 'github', hasToken: true, defaultBranch: 'main' }]) };
    const insights = { analyze: vi.fn().mockResolvedValue({
      framework: { name: 'Astro', category: 'ssr', port: 4321, installCmd: null, buildCmd: null, startCmd: null, env: [], notes: ['Static by default — set output: "server" to enable SSR.'] },
      language: 'TypeScript', nodeVersion: '20', packageManager: 'pnpm', frameworkVersion: '5',
      scripts: {}, dependencyCount: 1, devDependencyCount: 1, hasDockerfile: false, hasComposeFile: false, monorepo: false,
      detectedFiles: [], workspacePackages: [], baseDir: '.', commitSha: null, analyzedAt: '2026-01-01T00:00:00.000Z',
    }) };
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'x' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 1 });
    h.prompt
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // name
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('/') // health path
      .mockResolvedValueOnce('n') // override
      .mockResolvedValueOnce('') // env loop end
      .mockResolvedValueOnce('n') // skip deploy
      .mockResolvedValueOnce('n'); // skip webhook
    await deployFromGithub(makeClient({ sources, insights, services: { create }, deploys: { trigger } }), 'https://github.com/owner/app');
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('Static by default');
  });

  it('surfaces the table + pick flow for a non-provider URL with sources', async () => {
    // Specifically covers the second branch in the source-resolution block
    // (provider is null, sources exist, no token-bearing match).
    const sources = { list: vi.fn().mockResolvedValue([
      { id: 11, name: 'self', type: 'custom', hasToken: true, defaultBranch: 'main' },
    ]) };
    const insights = { analyze: vi.fn().mockResolvedValue(null) };
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'x' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 1 });
    h.prompt
      .mockResolvedValueOnce('11') // source id (the inner "no provider detected" prompt)
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // name
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('/') // health path
      .mockResolvedValueOnce('n') // override
      .mockResolvedValueOnce('') // env loop
      .mockResolvedValueOnce('n') // skip deploy
      .mockResolvedValueOnce('n'); // skip webhook
    await deployFromGithub(makeClient({ sources, insights, services: { create }, deploys: { trigger } }), 'https://git.example.com/owner/app');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 11 }));
  });

  it('auto-creates a GitLab source for a gitlab.com URL', async () => {
    const sources = { list: vi.fn().mockResolvedValue([]) };
    const sourcesCreate = vi.fn().mockResolvedValue({ id: 7, name: 'gl-new', type: 'gitlab' });
    const insights = { analyze: vi.fn().mockResolvedValue(null) };
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'x' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 1 });
    h.prompt
      .mockResolvedValueOnce('main') // branch
      .mockResolvedValueOnce('') // name
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('/') // health path
      .mockResolvedValueOnce('n') // override
      .mockResolvedValueOnce('') // env loop
      .mockResolvedValueOnce('n') // skip deploy
      .mockResolvedValueOnce('n'); // skip webhook
    process.env['NINEDEPLOY_GITLAB_TOKEN'] = 'glpat_inline';
    try {
      await deployFromGithub(makeClient({ sources: { list: sources.list, create: sourcesCreate }, insights, services: { create }, deploys: { trigger } }), 'https://gitlab.com/owner/app');
    } finally {
      delete process.env['NINEDEPLOY_GITLAB_TOKEN'];
    }
    expect(sourcesCreate).toHaveBeenCalledWith(expect.objectContaining({ type: 'gitlab', token: 'glpat_inline' }));
  });

  it('derives a sensible default service name from a quirky clone URL', async () => {
    const sources = { list: vi.fn().mockResolvedValue([{ id: 1, name: 'gh', type: 'github', hasToken: true, defaultBranch: 'main' }]) };
    const insights = { analyze: vi.fn().mockResolvedValue(null) };
    const create = vi.fn().mockResolvedValue({ id: 1, name: 'x' });
    const trigger = vi.fn().mockResolvedValue({ deploymentId: 1 });
    h.prompt
      .mockResolvedValueOnce('main') // branch
      // user accepts the default name (empty)
      .mockResolvedValueOnce('') // name (default)
      .mockResolvedValueOnce('auto') // build pack
      .mockResolvedValueOnce('') // port
      .mockResolvedValueOnce('/') // health path
      .mockResolvedValueOnce('n') // override
      .mockResolvedValueOnce('') // env loop
      .mockResolvedValueOnce('n') // skip deploy
      .mockResolvedValueOnce('n'); // skip webhook
    await deployFromGithub(makeClient({ sources, insights, services: { create }, deploys: { trigger } }), 'https://github.com/owner/my-cool-app.git');
    // "my-cool-app" → "My Cool App" via the helper
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Cool App' }));
  });
});
