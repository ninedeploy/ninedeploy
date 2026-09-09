import { describe, expect, it, vi } from 'vitest';
import {
  isManagedVolume,
  safeRelPath,
  listVolumeDir,
  readVolumeFile,
  writeVolumeFile,
  makeVolumeDir,
  deleteVolumePath,
} from '../../src/engine/volumeFiles.js';

const execMocks = vi.hoisted(() => ({ capture: vi.fn(), run: vi.fn() }));
vi.mock('../../src/lib/exec.js', () => execMocks);
const dockerPullMocks = vi.hoisted(() => ({ ensureDockerImage: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/dockerPull.js', () => dockerPullMocks);

describe('volume file helpers (pure)', () => {
  it('isManagedVolume accepts only nd- managed names', () => {
    expect(isManagedVolume('nd-svc-web-data')).toBe(true);
    expect(isManagedVolume('nd-db-pg-data')).toBe(true);
    expect(isManagedVolume('my-volume')).toBe(false);
    expect(isManagedVolume('nd-svc-../etc')).toBe(false);
    expect(isManagedVolume('')).toBe(false);
  });

  it('safeRelPath normalises and rejects escapes', () => {
    expect(safeRelPath('')).toBe('');
    expect(safeRelPath('a/b/c.txt')).toBe('a/b/c.txt');
    expect(safeRelPath('/a//b/./c/')).toBe('a/b/c');
    expect(safeRelPath('a/../../b')).toBeNull();
    expect(safeRelPath('..')).toBeNull();
    expect(safeRelPath('a\nb')).toBeNull();
    expect(safeRelPath('a\0b')).toBeNull();
  });
});

describe('volume file operations (docker sidecar)', () => {
  it('lists a directory via busybox stat (alpine has no find -printf)', async () => {
    execMocks.capture.mockResolvedValue(
      'directory|4096|1786886400|./configs\nregular file|128|1786886401|./app.env\n',
    );
    const entries = await listVolumeDir('nd-svc-web-data', 'configs');
    expect(dockerPullMocks.ensureDockerImage).toHaveBeenCalledWith('alpine:3.21', expect.any(Function));
    expect(execMocks.capture).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['run', '--rm', '-v', 'nd-svc-web-data:/v', 'alpine:3.21']),
    );
    expect(entries).toEqual([
      { name: 'configs', type: 'dir', sizeBytes: 4096, modifiedAt: new Date(1786886400 * 1000).toISOString() },
      { name: 'app.env', type: 'file', sizeBytes: 128, modifiedAt: new Date(1786886401 * 1000).toISOString() },
    ]);
  });

  it('reads a file as base64 with a 1MB cap', async () => {
    execMocks.capture.mockResolvedValue('aGVsbG8=');
    const file = await readVolumeFile('nd-svc-web-data', 'app.env');
    expect(file).toEqual({ content: 'aGVsbG8=', encoding: 'base64' });
    const args = execMocks.capture.mock.calls.at(-1)?.[1] as string[];
    expect(args.join(' ')).toContain('tail -c 1048576');
  });

  it('writes base64 content through stdin, never argv', async () => {
    execMocks.run.mockResolvedValue(undefined);
    await writeVolumeFile('nd-svc-web-data', 'a/app.env', 'aGVsbG8=', () => {});
    const args = execMocks.run.mock.calls.at(-1)?.[1] as string[];
    const joined = args.join(' ');
    expect(joined).toContain('base64 -d');
    expect(joined).not.toContain('aGVsbG8='); // content only via stdin
    expect(execMocks.run.mock.calls.at(-1)?.[4]).toEqual(Buffer.from('aGVsbG8='));
  });

  it('creates directories with mkdir -p and -- separator', async () => {
    execMocks.capture.mockResolvedValue('');
    await makeVolumeDir('nd-svc-web-data', 'a/b');
    const args = execMocks.capture.mock.calls.at(-1)?.[1] as string[];
    expect(args).toContain('--');
    expect(args.at(-1)).toBe('/v/a/b');
  });

  it('skips malformed listing lines instead of choking', async () => {
    execMocks.capture.mockResolvedValue([
      'symbolic link|1|1786886400|./alink',        // neither dir nor regular file
      'regular file|||',                             // unparsable size + missing mtime/name
      'regular file|not-a-number|0|./nofile',       // unparsable size → 0
      'regular file|5|1786886400|./ok.txt',
      'directory|4096|1786886400|./with|pipe',  // '|' in the name: rest joins back
      'directory|junk|1786886400|./badsize',   // dir with unparsable size → 0
    ].join('\n'));
    const entries = await listVolumeDir('nd-svc-web-data', '');
    expect(entries).toEqual([
      { name: 'nofile', type: 'file', sizeBytes: 0, modifiedAt: null },
      { name: 'ok.txt', type: 'file', sizeBytes: 5, modifiedAt: new Date(1786886400 * 1000).toISOString() },
      { name: 'with|pipe', type: 'dir', sizeBytes: 4096, modifiedAt: new Date(1786886400 * 1000).toISOString() },
      { name: 'badsize', type: 'dir', sizeBytes: 0, modifiedAt: new Date(1786886400 * 1000).toISOString() },
    ]);
  });

  it('rejects oversized path segments', () => {
    expect(safeRelPath(`${'a'.repeat(256)}.txt`)).toBeNull();
    expect(safeRelPath(`${'a'.repeat(250)}.txt`)).not.toBeNull();
  });

  it('deletes paths with rm -rf and -- separator', async () => {
    execMocks.run.mockResolvedValue(undefined);
    await deleteVolumePath('nd-svc-web-data', 'a/b', () => {});
    const args = execMocks.run.mock.calls.at(-1)?.[1] as string[];
    expect(args.join(' ')).toContain('rm -rf -- /v/a/b');
  });
});
