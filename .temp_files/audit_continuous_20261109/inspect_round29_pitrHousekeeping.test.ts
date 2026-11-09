import { beforeEach, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../../apps/server/src/lib/exec.js', () => seam);
const { prunePitrRecoveryHelpers } = await import('../../apps/server/src/lib/pitrHousekeeping.js');
const id = 'a'.repeat(64);
const now = Date.parse('2026-11-09T12:00:00Z');
const age = 7 * 60 * 60_000;
const name = '/nd-pitr-12345678-1234-1234-1234-123456789abc';
let ids: string;
let inspected: string;
let fail: string;
beforeEach(() => {
  ids = id; inspected = `${new Date(now - age).toISOString()} ${name}`; fail = '';
  seam.capture.mockReset().mockImplementation(async (_bin: string, args: string[]) => {
    if (args[0] === fail) throw new Error('injected unknown daemon error');
    if (args[0] === 'ps') { expect(args).toContain('label=ninedeploy.role=pitr-recovery'); return ids; }
    if (args[0] === 'inspect') return inspected;
    if (args[0] === 'rm') { expect(args).toEqual(['rm', '-f', id]); return id; }
    throw new Error('unexpected command');
  });
});
it('control: removes the exact helper at the age boundary', async () => {
  expect(await prunePitrRecoveryHelpers(age, now)).toBe(1);
  expect(seam.capture.mock.calls.map(call => call[1][0])).toEqual(['ps', 'inspect', 'rm']);
});
for (const data of [
  `${new Date(now - age + 1).toISOString()} ${name}`,
  `${new Date(now + age).toISOString()} ${name}`,
  `invalid-date ${name}`,
  `${new Date(now - age).toISOString()} /nd-db-user-data`,
  `${new Date(now - age).toISOString()} ${name}-extra`,
  `${new Date(now - age).toISOString()} /nd-pitr-1234`,
  '',
]) it(`does not delete uncertain or ineligible inspection ${JSON.stringify(data)}`, async () => {
  inspected = data;
  expect(await prunePitrRecoveryHelpers(age, now)).toBe(0);
  expect(seam.capture.mock.calls.some(call => call[1][0] === 'rm')).toBe(false);
});
it('filters malformed IDs before inspect or delete', async () => {
  ids = `${'a'.repeat(12)}\n$(command)\n${'A'.repeat(64)}\n--option\n`;
  expect(await prunePitrRecoveryHelpers(age, now)).toBe(0);
  expect(seam.capture).toHaveBeenCalledOnce();
});
for (const cmd of ['inspect', 'rm']) it(`uncertain ${cmd} failure is not credited as removal`, async () => {
  fail = cmd;
  expect(await prunePitrRecoveryHelpers(age, now)).toBe(0);
  if (cmd === 'inspect') expect(seam.capture.mock.calls.some(call => call[1][0] === 'rm')).toBe(false);
});
it('a list failure propagates without removing anything', async () => {
  fail = 'ps';
  await expect(prunePitrRecoveryHelpers(age, now)).rejects.toThrow('injected unknown daemon error');
  expect(seam.capture).toHaveBeenCalledOnce();
});
