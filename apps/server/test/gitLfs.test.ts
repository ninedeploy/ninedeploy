import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.16.3 Git LFS: pointers in a real (temporary) git checkout are replaced by
 * content fetched from the repository's own LFS API. HTTP is faked at
 * `guardedFetch`, the egress-checked fetch every request must go through.
 */

const egress = vi.hoisted(() => ({ guardedFetch: vi.fn() }));
vi.mock('../src/lib/egressGuard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/egressGuard.js')>()),
  guardedFetch: egress.guardedFetch,
}));

const { fetchLfsObjects, findLfsPointers, lfsEndpoint } = await import('../src/lib/gitLfs.js');

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const pointer = (content: string) => `version https://git-lfs.github.com/spec/v1\noid sha256:${sha(content)}\nsize ${Buffer.byteLength(content)}\n`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.git-lfs+json' } });

let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(path.join(tmpdir(), 'nd-lfs-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(path.join(dir, 'model.bin'), pointer('weights-v1'));
  writeFileSync(path.join(dir, 'copy.bin'), pointer('weights-v1'));
  writeFileSync(path.join(dir, 'logo.png'), pointer('png-bytes'));
  writeFileSync(path.join(dir, 'README.md'), '# not a pointer\n');
  writeFileSync(path.join(dir, 'untracked.bin'), pointer('never-fetched'));
  git('add', 'model.bin', 'copy.bin', 'logo.png', 'README.md');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake LFS server: the batch API on the repo host, objects on a CDN that redirects to storage. */
function serve(contents: Record<string, string>, over: { batch?: (body: { objects: Array<{ oid: string }> }) => Response } = {}) {
  egress.guardedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/objects/batch')) {
      const body = JSON.parse(String(init?.body)) as { objects: Array<{ oid: string; size: number }> };
      if (over.batch) return over.batch(body);
      return json({
        objects: body.objects.map((o) => ({ ...o, actions: { download: { href: `https://cdn.example.com/${o.oid}`, header: { 'X-Lfs-Ticket': 't' } } } })),
      });
    }
    if (url.startsWith('https://cdn.example.com/')) return new Response(null, { status: 302, headers: { location: `https://storage.example.net/${url.split('/').pop()}` } });
    if (url.startsWith('https://storage.example.net/')) {
      const oid = url.split('/').pop()!;
      const content = Object.values(contents).find((c) => sha(c) === oid);
      return content === undefined ? new Response('gone', { status: 404 }) : new Response(content);
    }
    throw new Error(`unexpected ${url}`);
  });
}

describe('lfsEndpoint', () => {
  it("is the repository's own .git/info/lfs, without credentials; SSH has none", () => {
    expect(lfsEndpoint('https://github.com/acme/app')).toBe('https://github.com/acme/app.git/info/lfs');
    expect(lfsEndpoint('https://u:p@gitlab.example.com/g/app.git/')).toBe('https://gitlab.example.com/g/app.git/info/lfs');
    expect(lfsEndpoint('git@github.com:acme/app.git')).toBeNull();
    expect(lfsEndpoint('ssh://git@github.com/acme/app.git')).toBeNull();
    expect(lfsEndpoint('not a url')).toBeNull();
  });
});

describe('Git LFS fetch', () => {
  it('finds only the tracked pointer files', async () => {
    const found = await findLfsPointers(dir);
    expect(found.map((p) => p.path).sort()).toEqual(['copy.bin', 'logo.png', 'model.bin']);
    expect(found.find((p) => p.path === 'logo.png')).toEqual({ path: 'logo.png', oid: sha('png-bytes'), size: 9 });
  });

  it('replaces each pointer with its verified content; the credential goes to the repository host only', async () => {
    serve({ a: 'weights-v1', b: 'png-bytes' });
    const log = vi.fn();
    const result = await fetchLfsObjects(dir, 'https://github.com/acme/app', { username: 'x-access-token', password: 'tok' }, log);
    expect(result).toEqual({ files: 3, bytes: 10 + 9 });
    expect(readFileSync(path.join(dir, 'model.bin'), 'utf8')).toBe('weights-v1');
    expect(readFileSync(path.join(dir, 'copy.bin'), 'utf8')).toBe('weights-v1');
    expect(readFileSync(path.join(dir, 'logo.png'), 'utf8')).toBe('png-bytes');
    expect(readFileSync(path.join(dir, 'untracked.bin'), 'utf8')).toBe(pointer('never-fetched'));

    const calls = egress.guardedFetch.mock.calls as Array<[string, RequestInit]>;
    const batch = calls.find(([u]) => u.endsWith('/objects/batch'))!;
    expect(batch[0]).toBe('https://github.com/acme/app.git/info/lfs/objects/batch');
    expect((batch[1].headers as Record<string, string>)['Authorization']).toBe(`Basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
    // One object requested once even though two paths share it.
    expect(JSON.parse(String(batch[1].body)).objects).toHaveLength(2);
    for (const [url, init] of calls.filter(([u]) => !u.endsWith('/objects/batch'))) {
      const headers = (init.headers ?? {}) as Record<string, string>;
      expect(headers['Authorization'], url).toBeUndefined();
      // The LFS server's per-object header goes to its own href, not across the redirect.
      expect(headers['X-Lfs-Ticket'], url).toBe(url.startsWith('https://cdn.example.com/') ? 't' : undefined);
    }
    expect(log).toHaveBeenCalledWith('Git LFS: fetching 2 object(s), 19 bytes, for 3 file(s) from github.com');
  });

  it('refuses content that does not match its pointer, and leaves the pointer in place', async () => {
    egress.guardedFetch.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith('/objects/batch')
        ? json({ objects: (JSON.parse(String(init?.body)) as { objects: Array<{ oid: string; size: number }> }).objects.map((o) => ({ ...o, actions: { download: { href: `https://cdn.example.com/${o.oid}` } } })) })
        : new Response('tampered!!'),
    );
    await expect(fetchLfsObjects(dir, 'https://github.com/acme/app', null, () => undefined)).rejects.toThrow(/does not match its pointer|larger than its pointer/);
    expect(readFileSync(path.join(dir, 'model.bin'), 'utf8')).toBe(pointer('weights-v1'));
  });

  it('explains a refused API call, an object error, a missing object and an SSH repository', async () => {
    serve({}, { batch: () => json({ message: 'no' }, 401) });
    await expect(fetchLfsObjects(dir, 'https://github.com/acme/app', null, () => undefined)).rejects.toThrow(/answered 401 — a private repository needs a Git credential/);
    serve({}, { batch: (b) => json({ objects: b.objects.map((o) => ({ ...o, error: { code: 404, message: 'Object does not exist' } })) }) });
    await expect(fetchLfsObjects(dir, 'https://github.com/acme/app', null, () => undefined)).rejects.toThrow(/Object does not exist \(404\)/);
    serve({}, { batch: () => json({ objects: [] }) });
    await expect(fetchLfsObjects(dir, 'https://github.com/acme/app', null, () => undefined)).rejects.toThrow(/did not return 2 object/);
    serve({}, { batch: (b) => json({ objects: b.objects.map((o) => ({ ...o })) }) });
    await expect(fetchLfsObjects(dir, 'https://github.com/acme/app', null, () => undefined)).rejects.toThrow(/no download offered/);
    serve({});
    await expect(fetchLfsObjects(dir, 'https://github.com/acme/app', null, () => undefined)).rejects.toThrow(/answered 404/);
    await expect(fetchLfsObjects(dir, 'git@github.com:acme/app.git', null, () => undefined)).rejects.toThrow(/HTTPS repository URL/);
  });

  it('a commit without LFS files asks nothing of the network', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'nd-lfs-plain-'));
    try {
      execFileSync('git', ['-C', plain, 'init', '-q']);
      writeFileSync(path.join(plain, 'a.txt'), 'a');
      execFileSync('git', ['-C', plain, 'add', 'a.txt']);
      const log = vi.fn();
      expect(await fetchLfsObjects(plain, 'https://github.com/acme/app', null, log)).toEqual({ files: 0, bytes: 0 });
      expect(egress.guardedFetch).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('Git LFS: no LFS files in this commit');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('stops a redirect loop', async () => {
    egress.guardedFetch.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith('/objects/batch')
        ? json({ objects: (JSON.parse(String(init?.body)) as { objects: Array<{ oid: string; size: number }> }).objects.map((o) => ({ ...o, actions: { download: { href: 'https://cdn.example.com/loop' } } })) })
        : new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/loop' } }),
    );
    await expect(fetchLfsObjects(dir, 'https://github.com/acme/app', null, () => undefined)).rejects.toThrow(/too many redirects/);
  });
});
