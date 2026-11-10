import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const execution = vi.hoisted(() => ({ invoke: undefined as undefined | ((args: string[]) => Promise<string>), copied: false }));
vi.mock('../../src/lib/exec.js', () => ({
  ExecTimeoutError: class extends Error {},
  capture: async (_cmd: string, args: string[]) => execution.invoke!(args),
  run: async (_cmd: string, args: string[]) => {
    if (args[0] === 'rm') { await execution.invoke!(args); return; }
    if (args[0] === 'cp') { expect(await readFile(args[1]!, 'utf8')).toBe('owned fixture bytes'); execution.copied = true; return; }
    if (args[0] === 'start') return;
    throw new Error('Unscripted fixture command');
  },
}));
const { validateDumpFile } = await import('../../src/lib/backupDrill.js');
const roots: string[] = [];
afterEach(async () => {
  execution.invoke = undefined; execution.copied = false;
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('nd-drill-native-')) throw new Error('Unowned fixture cleanup');
    await rm(absolute, { recursive: true, force: true });
  }
});
async function check(lost: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'nd-drill-native-')); roots.push(root);
  await writeFile(join(root, 'config.json'), JSON.stringify({ auths: { 'unrelated.invalid': { auth: Buffer.from('fixture:invalid').toString('base64') } }, credsStore: '', credHelpers: {} }));
  const file = join(root, 'source.rdb'); await writeFile(file, 'owned fixture bytes');
  const id = 'b'.repeat(64), image = `sha256:${'a'.repeat(64)}`;
  let container: { name: string; id: string } | undefined, volume = false;
  const deletes: string[] = [], unexpected: string[] = [];
  const api = createServer(async (request, response) => {
    const url = new URL(request.url ?? '', 'http://fixture.invalid');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/_ping') { response.setHeader('API-Version', '1.52'); response.setHeader('OSType', 'linux'); response.end('OK'); return; }
    if (request.method === 'GET' && /\/images\/.*\/json$/.test(url.pathname)) {
      response.end(JSON.stringify({ Id: image, Config: { Volumes: { '/data': {} } }, Os: 'linux', Architecture: 'amd64' })); return;
    }
    if (request.method === 'POST' && url.pathname.endsWith('/containers/create')) {
      for await (const _chunk of request) { /* consume native CLI JSON */ }
      container = { name: url.searchParams.get('name') ?? '', id }; volume = true;
      if (lost) { request.socket.destroy(); return; }
      response.statusCode = 201; response.end(JSON.stringify({ Id: id, Warnings: [] })); return;
    }
    if (request.method === 'DELETE' && url.pathname.includes('/containers/')) {
      deletes.push(url.search); const target = decodeURIComponent(url.pathname.split('/').at(-1)!);
      if (container && (target === container.id || target === container.name)) {
        container = undefined; if (['1', 'true'].includes(url.searchParams.get('v') ?? '')) volume = false;
        response.statusCode = 204; response.end(); return;
      }
      response.statusCode = 404; response.end(JSON.stringify({ message: 'No such fixture container' })); return;
    }
    unexpected.push(`${request.method} ${url.pathname}`); response.statusCode = 404; response.end(JSON.stringify({ message: 'Controlled daemon route refused' }));
  });
  await new Promise<void>(done => api.listen(0, '127.0.0.1', done));
  const address = api.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  const env = { ...Object.fromEntries(['SystemRoot', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]])), DOCKER_API_VERSION: '1.52' };
  execution.invoke = args => new Promise((done, reject) => {
    const child = spawn('docker', ['--host', `tcp://127.0.0.1:${address.port}`, '--config', root, ...args], { env, windowsHide: true });
    let output = '', error = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Owned Docker fixture deadline')); }, 15_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); if (code === 0) done(output); else reject(new Error(`Native Docker exit ${code}: ${error}`)); }); child.stdin.end();
  });
  try {
    const result = await validateDumpFile('redis', file, 'redis:fixture');
    expect(unexpected).toEqual([]);
    return { result, container, volume, deletes, source: await readFile(file, 'utf8'), copied: execution.copied };
  } finally { api.closeAllConnections(); await new Promise<void>(done => api.close(() => done())); }
}
it('native CLI normal create is followed by container removal', async () => { const result = await check(false); expect(result.result.outcome).toBe('passed'); expect(result.container).toBeUndefined(); expect(result.copied).toBe(true); expect(result.source).toBe('owned fixture bytes'); });
it('native CLI lost create response still reaches helper cleanup', async () => { const result = await check(true); expect(result.result.outcome).toBe('unverifiable'); expect(result.copied).toBe(false); expect(result.container).toBeUndefined(); expect(result.volume).toBe(false); });
it('native CLI removal requests anonymous volume cleanup', async () => { const result = await check(false); expect(result.result.outcome).toBe('passed'); expect(result.volume).toBe(false); expect(result.deletes).toHaveLength(1); });
