import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.16.5 file mounts on a node (`docker.fileMounts`): the agent writes each
 * file under its home (`file.writeMount`, 0700 directories, 0644 files, three
 * deployments kept), `docker.runSpec` mounts what it wrote read-only and
 * nothing else, and the panel sends the files only to an agent that
 * advertises the capability.
 */

const spawn = vi.hoisted(() => ({ spawnValidated: vi.fn(async () => 0) }));
vi.mock('../src/lib/spawnValidated.js', () => spawn);

const { AGENT_OPS, advertisedCapabilities, runRegisteredOp } = await import('../src/agentOps/index.js');
const { FILES_DIR, fileMountOps, parseFileMounts } = await import('../src/agentOps/fileMounts.js');
const { parseRunSpec, runSpecArgv } = await import('../src/agentOps/runSpec.js');
const { runSpecParams } = await import('../src/engine/builders/remoteRun.js');
const { NODE_FILE_MOUNTS_FEATURE, nodeFileMountChecks, nodeRunNeeds } = await import('../src/lib/remoteVolumes.js');
const { AGENT_CAPABILITY_VERSION } = await import('../src/lib/agentCapabilities.js');

let home: string;
const sealed = { sealed: true };
const run = (op: string, params: Record<string, unknown>, ctx = sealed) => {
  const lines: string[] = [];
  return runRegisteredOp(op, params, (l) => lines.push(l), ctx).then((code) => ({ code, lines }));
};
const write = (deploymentId: number, id: number, content = 'events {}') =>
  run('file.writeMount', { service: 'web', deploymentId, id, content });

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'nd-agent-files-'));
  vi.spyOn(process, 'cwd').mockReturnValue(home);
  spawn.spawnValidated.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe('file.writeMount / file.removeMounts (agent)', () => {
  it('writes the file under the agent home, answers its path, and keeps three deployments', async () => {
    expect(await write(11, 5)).toEqual({ code: 0, lines: [`wrote ${FILES_DIR}/web/d11/5`] });
    const file = path.join(home, FILES_DIR, 'web', 'd11', '5');
    expect(readFileSync(file, 'utf8')).toBe('events {}');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o644);
      for (const d of [FILES_DIR, `${FILES_DIR}/web`, `${FILES_DIR}/web/d11`]) expect(statSync(path.join(home, d)).mode & 0o777, d).toBe(0o700);
    }
    // Rewriting the same file replaces it.
    await write(11, 5, 'events { worker_connections 64; }');
    expect(readFileSync(file, 'utf8')).toBe('events { worker_connections 64; }');
    for (const d of [12, 13, 14]) await write(d, 5);
    expect(readdirSync(path.join(home, FILES_DIR, 'web')).sort()).toEqual(['d12', 'd13', 'd14']);
    // An older deployment written late is never pruned while it is written.
    await write(3, 5);
    expect(readdirSync(path.join(home, FILES_DIR, 'web')).sort()).toEqual(['d12', 'd13', 'd14', 'd3']);

    expect(await run('file.removeMounts', { service: 'web' }, { sealed: false })).toEqual({ code: 0, lines: [`removed ${FILES_DIR}/web`] });
    expect(existsSync(path.join(home, FILES_DIR, 'web'))).toBe(false);
  });

  it('does not follow a link left at the file name', async () => {
    if (process.platform === 'win32') return;
    const outside = path.join(home, 'outside');
    writeFileSync(outside, 'untouched');
    mkdirSync(path.join(home, FILES_DIR, 'web', 'd1'), { recursive: true });
    symlinkSync(outside, path.join(home, FILES_DIR, 'web', 'd1', '5'));
    await write(1, 5, 'new');
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    expect(readFileSync(path.join(home, FILES_DIR, 'web', 'd1', '5'), 'utf8')).toBe('new');
  });

  it.each([
    ['a traversing service name', { service: '../x', deploymentId: 1, id: 1, content: '' }, /Invalid service name/],
    ['a hidden service name', { service: '.agent-env', deploymentId: 1, id: 1, content: '' }, /Invalid service name/],
    ['a string deployment id', { service: 'web', deploymentId: '1', id: 1, content: '' }, /Invalid deploymentId/],
    ['a zero file id', { service: 'web', deploymentId: 1, id: 0, content: '' }, /Invalid file id/],
    ['content over 256 KiB', { service: 'web', deploymentId: 1, id: 1, content: 'x'.repeat(256 * 1024 + 1) }, /Invalid file content/],
    ['non-string content', { service: 'web', deploymentId: 1, id: 1, content: 5 }, /Invalid file content/],
    ['an unknown field', { service: 'web', deploymentId: 1, id: 1, content: '', mode: 0o777 }, /Invalid field: mode/],
  ])('refuses %s and writes nothing', async (_what, params, error) => {
    await expect(run('file.writeMount', params)).rejects.toThrow(error);
    expect(existsSync(path.join(home, FILES_DIR))).toBe(false);
  });

  it('refuses a write outside a sealed request, and a removal with a bad name', async () => {
    await expect(run('file.writeMount', { service: 'web', deploymentId: 1, id: 1, content: 'secret' }, { sealed: false })).rejects.toThrow(/sealed/);
    await expect(run('file.removeMounts', { service: '..' })).rejects.toThrow(/Invalid service name/);
    await expect(run('file.removeMounts', { service: 'web', all: true })).rejects.toThrow(/Invalid field: all/);
  });

  it('is registered and advertised as docker.fileMounts, first shipped by 0.16.5', () => {
    expect(fileMountOps.caps).toEqual(['docker.fileMounts']);
    expect(AGENT_OPS.get('file.writeMount')?.sealedOnly).toBe(true);
    expect(AGENT_OPS.get('file.removeMounts')?.sealedOnly).toBe(false);
    expect(advertisedCapabilities({})).toContain('docker.fileMounts');
    expect(AGENT_CAPABILITY_VERSION['docker.fileMounts']).toBe('0.16.5');
  });
});

describe('docker.runSpec fileMounts (agent)', () => {
  const base = { name: 'web-11', image: 'nginx:1' };
  const nginx = { file: `${FILES_DIR}/web/d11/5`, mount: '/etc/nginx/nginx.conf' };

  it('mounts each written file read-only from its host path, before the image', () => {
    const argv = runSpecArgv(parseRunSpec({ ...base, fileMounts: [nginx] }), 'run');
    const at = argv.indexOf(`${path.join(home, FILES_DIR, 'web', 'd11', '5')}:/etc/nginx/nginx.conf:ro`);
    expect(argv[at - 1]).toBe('-v');
    expect(at).toBeLessThan(argv.indexOf('nginx:1'));
    // No field: the argv is what 0.16.4 built.
    expect(runSpecArgv(parseRunSpec(base), 'run').filter((a) => a === '-v')).toHaveLength(0);
  });

  it.each([
    ['a file outside the files directory', { file: '.agent-env/web-11.env', mount: '/a' }, /Invalid file mount file/],
    ['a traversing file', { file: `${FILES_DIR}/../d1/5`, mount: '/a' }, /Invalid file mount file/],
    ['a bad service segment', { file: `${FILES_DIR}/-x/d1/5`, mount: '/a' }, /Invalid file mount file/],
    ['an id past 2^31', { file: `${FILES_DIR}/web/d1/9999999999`, mount: '/a' }, /Invalid file mount file/],
    ['a relative mount', { file: nginx.file, mount: 'etc/x' }, /Invalid file mount path/],
    ['a mount with a colon', { file: nginx.file, mount: '/etc/a:rw' }, /Invalid file mount path/],
    ['a mount with "..", ', { file: nginx.file, mount: '/etc/../proc/x' }, /Invalid file mount path/],
    ['a mount Docker manages', { file: nginx.file, mount: '/etc/hosts' }, /Invalid file mount path/],
    ['a mount over 255 characters', { file: nginx.file, mount: `/${'a'.repeat(300)}` }, /Invalid file mount path/],
    ['an unknown field', { ...nginx, readOnly: false }, /Invalid file mount field: readOnly/],
  ])('refuses %s', (_what, entry, error) => {
    expect(() => parseRunSpec({ ...base, fileMounts: [entry] })).toThrow(error);
  });

  it('refuses a list that is not one, too many files, and two mounts at one path', () => {
    expect(() => parseFileMounts('x')).toThrow(/Invalid fileMounts/);
    expect(() => parseFileMounts([null])).toThrow(/Invalid file mount/);
    expect(() => parseFileMounts(Array.from({ length: 21 }, (_, i) => ({ file: `${FILES_DIR}/web/d1/${i + 1}`, mount: `/a${i}` })))).toThrow(/Invalid fileMounts/);
    expect(() => parseRunSpec({ ...base, fileMounts: [nginx, { ...nginx, file: `${FILES_DIR}/web/d11/6` }] })).toThrow(/duplicate mount path/);
    expect(() => parseRunSpec({ ...base, volumes: [{ name: 'nd-svc-web-data', mount: '/etc/nginx/nginx.conf' }], fileMounts: [nginx] })).toThrow(/duplicate mount path/);
    expect(() => parseRunSpec({ ...base, dockerSocket: true, fileMounts: [{ ...nginx, mount: '/var/run/docker.sock' }] })).toThrow(/Invalid file mount path/);
  });

  it('starts nothing when a file was not written on the node (Docker would mount an empty directory)', async () => {
    await expect(run('docker.runSpec', { ...base, fileMounts: [nginx] })).rejects.toThrow(/was not written on this node/);
    expect(spawn.spawnValidated).not.toHaveBeenCalled();
    // A directory at the name is not a file either.
    mkdirSync(path.join(home, nginx.file), { recursive: true });
    await expect(run('docker.runSpec', { ...base, fileMounts: [nginx] })).rejects.toThrow(/was not written on this node/);
    rmSync(path.join(home, nginx.file), { recursive: true });
    await write(11, 5);
    expect((await run('docker.runSpec', { ...base, fileMounts: [nginx] })).code).toBe(0);
    expect(spawn.spawnValidated).toHaveBeenCalledWith('docker', expect.arrayContaining([`${path.join(home, nginx.file)}:/etc/nginx/nginx.conf:ro`]), expect.any(Function));
  });
});

describe('the panel side', () => {
  it('needs docker.fileMounts only for a service with files, in its own words', () => {
    expect(nodeRunNeeds({}, [], 2)).toEqual(['file mounts']);
    expect(nodeRunNeeds({}, [])).toEqual([]);
    expect(nodeFileMountChecks(2)).toEqual([{ cap: ['docker.runSpec', 'docker.fileMounts'], feature: NODE_FILE_MOUNTS_FEATURE }]);
    expect(nodeFileMountChecks(0)).toEqual([]);
  });

  it('sends fileMounts only when there are files; what it sends, the agent accepts', () => {
    const r = { name: 'web-11', image: 'nginx:1', envFile: '.agent-env/web-11.env', envFileName: 'web-11', deploymentId: 11, volumes: [] };
    const svc = { id: 3, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0 };
    const withFiles = runSpecParams(svc as never, { ...r, fileMounts: [{ file: `${FILES_DIR}/web/d11/5`, mount: '/etc/nginx/nginx.conf' }] });
    expect(withFiles['fileMounts']).toEqual([{ file: `${FILES_DIR}/web/d11/5`, mount: '/etc/nginx/nginx.conf' }]);
    expect(() => parseRunSpec(withFiles)).not.toThrow();
    expect(runSpecParams(svc as never, { ...r, fileMounts: [] })).not.toHaveProperty('fileMounts');
    expect(runSpecParams(svc as never, r)).not.toHaveProperty('fileMounts');
  });
});
