import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), killTree: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: mocks.spawn }));
vi.mock('../../src/lib/exec.js', async original => ({ ...await original<typeof import('../../src/lib/exec.js')>(), killTree: mocks.killTree }));
const { runTrivy } = await import('../../src/lib/imageScan.js');

class Process extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
}
let save: Process;
let scan: Process;
beforeEach(() => {
  save = new Process(); scan = new Process();
  mocks.spawn.mockReset().mockReturnValueOnce(save).mockReturnValueOnce(scan);
  mocks.killTree.mockReset();
});
afterEach(() => vi.useRealTimers());

it('rejects a failed image export even when the scanner exits successfully first', async () => {
  const result = runTrivy('sha256:fixture');
  scan.stdout.write('{"SchemaVersion":2,"Results":[]}');
  scan.emit('close', 0);
  save.stderr.write('export interrupted');
  save.emit('close', 1);
  await expect(result).rejects.toThrow('docker save failed: export interrupted');
});

it.each(['save-first', 'scan-first'])('accepts a report only after both processes succeed (%s)', async order => {
  const result = runTrivy('sha256:fixture');
  scan.stdout.write('{"SchemaVersion":2,"Results":[]}');
  if (order === 'save-first') { save.emit('close', 0); scan.emit('close', 0); }
  else { scan.emit('close', 0); save.emit('close', 0); }
  await expect(result).resolves.toBe('{"SchemaVersion":2,"Results":[]}');
});

it('rejects and stops both processes when the scanner fails', async () => {
  const result = runTrivy('sha256:fixture');
  scan.stderr.write('scanner unavailable');
  scan.emit('close', 1);
  await expect(result).rejects.toThrow('Trivy failed: scanner unavailable');
  expect(mocks.killTree).toHaveBeenCalledTimes(2);
});

it('keeps the deadline active after the scanner exits while export is still pending', async () => {
  vi.useFakeTimers();
  const result = runTrivy('sha256:fixture', { timeoutMs: 1000 });
  const rejection = expect(result).rejects.toThrow('The image scan timed out');
  scan.emit('close', 0);
  await vi.advanceTimersByTimeAsync(1000);
  await rejection;
  expect(mocks.killTree).toHaveBeenCalledTimes(2);
});

it.each(['save', 'scan'])('propagates a %s process startup failure', async failed => {
  const result = runTrivy('sha256:fixture');
  (failed === 'save' ? save : scan).emit('error', new Error('spawn failed'));
  await expect(result).rejects.toThrow('spawn failed');
  expect(mocks.killTree).toHaveBeenCalledTimes(2);
});
