import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ base: '', capture: vi.fn() }));
vi.mock('../../src/lib/nodeProxyFiles.js', () => ({ nodeProxyDirectory: () => h.base }));
vi.mock('../../src/lib/exec.js', () => ({ capture: h.capture }));

const { ensureNodePagesServer, NODE_PAGES_MAX_BYTES, nodePagesRunArgs, pruneNodePages, writeNodePages } = await import('../../src/lib/nodePages.js');
const { nodePagesOps } = await import('../../src/agentOps/nodePages.js');

/** P2, agent side: the files the node's page server reads, and the server's container. */
const page = { serviceId: 5, hosts: ['shop.example.com', '*.stores.example.com'], maintenance: { html: '<h1>Down</h1>', text: 'Down.\n', retryAfter: 60 }, errors: { '502': '<h1>Oops</h1>' } };
const pagesDir = () => join(h.base, 'pages');

beforeEach(() => {
  h.base = mkdtempSync(join(tmpdir(), 'nd-agent-proxy-'));
  h.capture.mockReset();
});
afterEach(() => rmSync(h.base, { recursive: true, force: true }));

describe('writeNodePages / pruneNodePages', () => {
  it('writes one world-readable file per service, and leaves unchanged content alone', () => {
    expect(writeNodePages(page)).toEqual({ serviceId: 5, changed: true });
    const file = join(pagesDir(), '5.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ hosts: page.hosts, maintenance: page.maintenance, errors: page.errors });
    // The server runs as nobody: the directory and the file must be readable by it.
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o644);
      expect(statSync(pagesDir()).mode & 0o777).toBe(0o755);
    }
    expect(writeNodePages(page)).toEqual({ serviceId: 5, changed: false });
    expect(writeNodePages({ ...page, maintenance: null })).toEqual({ serviceId: 5, changed: true });
  });

  it('takes no path, no unknown field and no bad host from the caller', () => {
    expect(() => writeNodePages({ ...page, serviceId: '../x' })).toThrow();
    expect(() => writeNodePages({ ...page, serviceId: 0 })).toThrow();
    expect(() => writeNodePages({ ...page, hosts: ['shop.example.com/../x'] })).toThrow();
    expect(() => writeNodePages({ ...page, hosts: [] })).toThrow();
    expect(() => writeNodePages({ ...page, errors: { '500': 'x' } })).toThrow();
    expect(() => writeNodePages({ ...page, path: '/etc' })).toThrow();
    expect(existsSync(join(pagesDir(), '5.json'))).toBe(false);
  });

  it('refuses one service whose pages would not fit, once JSON-escaped', () => {
    const quotes = '"'.repeat(65_536);
    expect(() => writeNodePages({ ...page, maintenance: { ...page.maintenance, html: quotes }, errors: { '502': quotes, '503': quotes, '504': quotes } })).toThrow(/too large/);
    expect(NODE_PAGES_MAX_BYTES).toBeGreaterThan(3 * 65_536);
  });

  it('prunes every service not kept, stray temp files too, and touches nothing else', () => {
    writeNodePages(page);
    writeNodePages({ ...page, serviceId: 6 });
    writeFileSync(join(pagesDir(), '5.json.tmp'), 'half');
    writeFileSync(join(pagesDir(), 'README'), 'keep me');
    expect(pruneNodePages({ keep: [5] })).toEqual({ removed: [6] });
    expect(readdirSync(pagesDir()).sort()).toEqual(['5.json', 'README']);
    expect(() => pruneNodePages({ keep: ['5'] })).toThrow();
  });
});

describe('ensureNodePagesServer', () => {
  const AGENT = `${'a'.repeat(64)}|sha256:${'1'.repeat(64)}|true|`;
  const ours = (image: string, running = true) => `${'b'.repeat(64)}|sha256:${image.repeat(64)}|${running}|pages`;
  /** Answer docker by its subcommand; `inspect` by container name. */
  const docker = (answers: { pages?: string | null; health?: boolean[]; agent?: string | null }) => {
    const health = [...(answers.health ?? [true])];
    h.capture.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'inspect') {
        const v = args[1] === 'ninedeploy-agent' ? (answers.agent === undefined ? AGENT : answers.agent) : answers.pages;
        if (v == null) throw new Error('No such object');
        return v;
      }
      if (args[0] === 'exec') {
        if (health.shift() ?? true) return '';
        throw new Error('unhealthy');
      }
      if (args[0] === 'run') answers.pages = ours('1');
      return '';
    });
  };

  it('keeps a running, healthy server of the agent own image', async () => {
    docker({ pages: ours('1') });
    await expect(ensureNodePagesServer()).resolves.toEqual({ id: 'b'.repeat(64), created: false });
    expect(h.capture.mock.calls.map((c) => (c[1] as string[])[0])).not.toContain('run');
  });

  it('recreates a stale or stopped server, creating the proxy network first, and waits until it answers', async () => {
    docker({ pages: ours('2'), health: [false, true] });
    await expect(ensureNodePagesServer()).resolves.toMatchObject({ created: true });
    const subs = h.capture.mock.calls.map((c) => (c[1] as string[]).slice(0, 2).join(' '));
    expect(subs).toEqual(expect.arrayContaining(['rm -fv', 'network create', 'run -d']));
    expect(subs.indexOf('network create')).toBeLessThan(subs.indexOf('run -d'));
  });

  it('refuses without the agent container, next to a foreign container, and when the server never answers', async () => {
    docker({ agent: null });
    await expect(ensureNodePagesServer()).rejects.toMatchObject({ code: 'node_pages_unsupported', statusCode: 409 });
    docker({ pages: `${'c'.repeat(64)}|sha256:${'1'.repeat(64)}|true|` });
    await expect(ensureNodePagesServer()).rejects.toMatchObject({ code: 'node_pages_conflict' });
    expect(h.capture.mock.calls.map((c) => (c[1] as string[])[0])).not.toContain('rm');
    docker({ pages: null, health: Array(40).fill(false) });
    await expect(ensureNodePagesServer()).rejects.toMatchObject({ code: 'node_pages_unconfirmed' });
  }, 30_000);

  it('runs read-only, unprivileged, unpublished, with the pages mounted read-only', () => {
    const args = nodePagesRunArgs('sha256:abc', '/var/lib/ninedeploy-agent/.agent-proxy/pages');
    expect(args).toEqual(expect.arrayContaining(['--read-only', '--user', '65534:65534', '--cap-drop', 'ALL', '--network', 'ninedeploy',
      '--mount', 'type=bind,source=/var/lib/ninedeploy-agent/.agent-proxy/pages,destination=/pages,readonly']));
    expect(args.join(' ')).not.toMatch(/ -p | --publish/);
    // Only the agent's own image, running the page server script: nothing caller-chosen.
    expect(args.slice(-4)).toEqual(['--entrypoint', 'node', 'sha256:abc', '/app/apps/server/dist/pageServer.js']);
  });
});

describe('agent ops', () => {
  const run = async (op: string, params: unknown) => {
    const lines: string[] = [];
    const code = await nodePagesOps.ops[op]!.run(params as never, (l) => lines.push(l), { sealed: true });
    return { code, reply: JSON.parse(lines[0]!.slice('ND-PAGES '.length)) };
  };
  it('answers one ND-PAGES line, with the error code on a refusal; every op is sealed only', async () => {
    expect(await run('proxy.pages.write', page)).toEqual({ code: 0, reply: { serviceId: 5, changed: true } });
    expect(await run('proxy.pages.prune', { keep: [] })).toEqual({ code: 0, reply: { removed: [5] } });
    const bad = await run('proxy.pages.write', { serviceId: -1 });
    expect(bad.code).toBe(1);
    expect(bad.reply.error).toMatchObject({ status: 400, code: 'node_pages_failed' });
    h.capture.mockRejectedValue(new Error('No such object'));
    expect((await run('proxy.pages.ensure', {})).reply.error).toMatchObject({ status: 409, code: 'node_pages_unsupported' });
    expect(Object.values(nodePagesOps.ops).every((o) => o.sealedOnly === true && o.cap === 'proxy.pages')).toBe(true);
  });
});
