import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupPolicyGet, backupPolicySet, mergePolicyInput } from '../src/commands/backupPolicy.js';

const builtIn = {
  databaseId: 4,
  configured: false,
  enabled: true,
  cron: null,
  retainCount: 7,
  retainRemoteCount: null,
  destinationId: null,
  localOnly: false,
  nextRunAt: null,
  updatedAt: null,
};
const saved = { ...builtIn, configured: true, cron: '0 */6 * * *', retainCount: 14, nextRunAt: '2026-10-08T12:00:00.000Z' };

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('mergePolicyInput', () => {
  it('applies a preset over the built-in defaults', () => {
    expect(mergePolicyInput(builtIn, { preset: '6h', keep: '14' })).toEqual({
      enabled: true,
      cron: '0 */6 * * *',
      retainCount: 14,
      retainRemoteCount: null,
      destinationId: null,
      localOnly: false,
    });
  });

  it('keeps the current values for unset flags (PUT replaces)', () => {
    const current = { ...saved, retainRemoteCount: 30, destinationId: 2 };
    expect(mergePolicyInput(current, { disable: true })).toEqual({
      enabled: false,
      cron: '0 */6 * * *',
      retainCount: 14,
      retainRemoteCount: 30,
      destinationId: 2,
      localOnly: false,
    });
  });

  it('maps --destination local / active / <id>', () => {
    expect(mergePolicyInput(saved, { destination: 'local' })).toMatchObject({ localOnly: true, destinationId: null, retainRemoteCount: null });
    expect(mergePolicyInput({ ...saved, localOnly: true }, { destination: 'active' })).toMatchObject({ localOnly: false, destinationId: null });
    expect(mergePolicyInput(saved, { destination: '3' })).toMatchObject({ localOnly: false, destinationId: 3 });
  });

  it('refuses ambiguous or missing input', () => {
    expect(() => mergePolicyInput(builtIn, {})).toThrow(/No schedule yet/);
    expect(() => mergePolicyInput(builtIn, { preset: 'hourly' })).toThrow(/--preset/);
    expect(() => mergePolicyInput(saved, { enable: true, disable: true })).toThrow(/either/);
    expect(() => mergePolicyInput(saved, { keep: 'ten' })).toThrow(/--keep/);
    expect(() => mergePolicyInput(saved, { destination: '0x1' })).toThrow(/--destination/);
  });
});

describe('databases backup-policy', () => {
  it('get prints the built-in schedule when no policy is saved', async () => {
    const client = { backups: { getPolicy: vi.fn().mockResolvedValue(builtIn) } };
    await backupPolicyGet(client as never, '4');
    expect(client.backups.getPolicy).toHaveBeenCalledWith(4);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('built-in (daily, 7 kept'));
  });

  it('set merges the flags into the current policy and saves it', async () => {
    const client = { backups: { getPolicy: vi.fn().mockResolvedValue(builtIn), setPolicy: vi.fn().mockResolvedValue(saved) } };
    await backupPolicySet(client as never, '4', { cron: '0 */6 * * *', keep: '14' });
    expect(client.backups.setPolicy).toHaveBeenCalledWith(4, expect.objectContaining({ cron: '0 */6 * * *', retainCount: 14 }));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('0 */6 * * *'));
    expect(process.exitCode).toBe(0);
  });

  it('set reports a server refusal as an error exit', async () => {
    const client = {
      backups: { getPolicy: vi.fn().mockResolvedValue(saved), setPolicy: vi.fn().mockRejectedValue(new Error('Invalid cron expression')) },
    };
    await backupPolicySet(client as never, '4', { cron: '* * * * * *' });
    expect(process.exitCode).toBe(1);
  });

  it('rejects a non-canonical database id', async () => {
    const client = { backups: { getPolicy: vi.fn() } };
    await expect(backupPolicyGet(client as never, '0x4')).rejects.toThrow(/Usage/);
    expect(client.backups.getPolicy).not.toHaveBeenCalled();
  });
});
