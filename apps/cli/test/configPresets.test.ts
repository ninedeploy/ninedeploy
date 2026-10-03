import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configPresetApply,
  configPresetApplyAction,
  configPresetGet,
  configPresetGetAction,
  configPresetList,
  configPresetListAction,
  configPresetRegister,
  configPresetRegisterAction,
  configPresetRemove,
  configPresetRemoveAction,
} from '../src/commands/configPresets.js';

const h = vi.hoisted(() => ({
  errorSpy: vi.fn(),
  infoSpy: vi.fn(),
  successSpy: vi.fn(),
  headerSpy: vi.fn(),
}));

vi.mock('../src/lib/format.js', () => ({
  error: h.errorSpy,
  header: h.headerSpy,
  info: h.infoSpy,
  success: h.successSpy,
}));

function makeClient(over: {
  list?: unknown | Error;
  get?: unknown | Error;
  register?: unknown | Error;
  apply?: unknown | Error;
  remove?: unknown | Error;
}) {
  const call = (fn: 'list' | 'get' | 'register' | 'apply' | 'remove') => {
    const v = over[fn];
    if (v instanceof Error) throw v;
    // Any other non-object value (string, number, undefined) is treated as
    // a thrown non-Error so the action's `String(err)` branch is exercised.
    if (v !== null && (typeof v !== 'object' || Array.isArray(v))) throw v;
    return v;
  };
  return {
    configPresets: {
      list: vi.fn(async () => call('list')),
      get: vi.fn(async () => call('get')),
      register: vi.fn(async () => call('register')),
      apply: vi.fn(async () => call('apply')),
      remove: vi.fn(async () => call('remove')),
    },
  } as never;
}

let tmpDir: string;
let savedExitCode: number | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  tmpDir = mkdtempSync(join(tmpdir(), 'ninedeploy-config-preset-'));
});

afterEach(() => {
  process.exitCode = savedExitCode;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('config-preset — pure entry points', () => {
  it('configPresetList returns the upstream list', async () => {
    const client = makeClient({ list: { presets: ['cloudflare-prod', 'minimal'] } });
    await expect(configPresetList(client)).resolves.toEqual({ presets: ['cloudflare-prod', 'minimal'] });
  });

  it('configPresetGet returns the full detail object', async () => {
    const detail = { id: 'p1', description: 'desc', values: { k: 'v' }, createdAt: '2026-08-29T00:00:00.000Z' };
    const client = makeClient({ get: detail });
    await expect(configPresetGet(client, 'p1')).resolves.toEqual(detail);
  });

  it('configPresetRegister parses a JSON file and posts it', async () => {
    const file = join(tmpDir, 'p1.json');
    writeFileSync(file, JSON.stringify({ 'k1': 'v1', 'k2': 42 }));
    const client = makeClient({ register: { ok: true, id: 'p1', keyCount: 2 } });
    const result = await configPresetRegister(client, 'p1', { file, description: 'd' });
    expect(result).toEqual({ ok: true, id: 'p1', keyCount: 2 });
    const call = (client.configPresets.register as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { id: string; description?: string; values: Record<string, unknown> };
    expect(call.id).toBe('p1');
    expect(call.description).toBe('d');
    expect(call.values).toEqual({ k1: 'v1', k2: 42 });
  });

  it('configPresetRegister throws when the JSON is not an object', async () => {
    const file = join(tmpDir, 'bad.json');
    writeFileSync(file, JSON.stringify(['this', 'is', 'an', 'array']));
    const client = makeClient({ register: { ok: true, id: 'p1', keyCount: 0 } });
    await expect(configPresetRegister(client, 'p1', { file })).rejects.toThrow(/JSON object/);
  });

  it('configPresetRegister throws when the JSON file is malformed', async () => {
    const file = join(tmpDir, 'broken.json');
    writeFileSync(file, '{ this is not json');
    const client = makeClient({ register: { ok: true, id: 'p1', keyCount: 0 } });
    await expect(configPresetRegister(client, 'p1', { file })).rejects.toThrow(/Invalid JSON/);
  });

  it('configPresetRegister handles the JSON.parse non-Error throw branch', async () => {
    // Reach into `JSON.parse` to make it throw a non-Error — exercises the
    // `err instanceof Error ? err.message : String(err)` fallback.
    const realParse = JSON.parse;
    JSON.parse = (() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'string-only parse error';
    }) as typeof JSON.parse;
    try {
      const file = join(tmpDir, 'x.json');
      writeFileSync(file, 'irrelevant');
      const client = makeClient({ register: { ok: true, id: 'x', keyCount: 0 } });
      await expect(configPresetRegister(client, 'x', { file })).rejects.toThrow(/string-only parse error/);
    } finally {
      JSON.parse = realParse;
    }
  });

  it('configPresetRegister throws when --file is missing', async () => {
    const client = makeClient({ register: { ok: true, id: 'p1', keyCount: 0 } });
    await expect(configPresetRegister(client, 'p1', {})).rejects.toThrow(/--file/);
  });

  it('configPresetApply posts the id and optional override', async () => {
    const client = makeClient({ apply: { ok: true, id: 'p1', keyCount: 2 } });
    const result = await configPresetApply(client, 'p1', { override: { k1: 'one-shot' } });
    expect(result).toEqual({ ok: true, id: 'p1', keyCount: 2 });
    const call = (client.configPresets.apply as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(call[0]).toBe('p1');
    expect(call[1]).toEqual({ override: { k1: 'one-shot' } });
  });

  it('configPresetRemove posts the id', async () => {
    const client = makeClient({ remove: { ok: true, id: 'p1' } });
    await expect(configPresetRemove(client, 'p1')).resolves.toEqual({ ok: true, id: 'p1' });
  });
});

describe('config-preset — CLI actions', () => {
  it('configPresetListAction prints every preset on its own line and prints a hint when empty', async () => {
    const client = makeClient({ list: { presets: [] } });
    await configPresetListAction(client);
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringMatching(/No presets are registered/));
  });

  it('configPresetListAction prints each id on its own line when populated', async () => {
    const client = makeClient({ list: { presets: ['a', 'b'] } });
    await configPresetListAction(client);
    expect(h.infoSpy).toHaveBeenCalledWith('• a');
    expect(h.infoSpy).toHaveBeenCalledWith('• b');
  });

  it('configPresetListAction surfaces upstream errors as non-zero exits', async () => {
    const client = makeClient({ list: new Error('connection refused') });
    await configPresetListAction(client);
    expect(h.errorSpy).toHaveBeenCalledWith('connection refused');
    expect(process.exitCode).toBe(1);
  });

  it('configPresetListAction falls back to String() for non-Error rejections', async () => {
    const client = makeClient({ list: 'plain text failure' });
    await configPresetListAction(client);
    expect(h.errorSpy).toHaveBeenCalledWith('plain text failure');
    expect(process.exitCode).toBe(1);
  });

  it('configPresetGetAction prints the description and every key=value', async () => {
    const client = makeClient({
      get: { id: 'p1', description: 'first', values: { k1: 'v1', k2: 42 }, createdAt: '2026-08-29T00:00:00.000Z' },
    });
    await configPresetGetAction(client, 'p1');
    expect(h.infoSpy).toHaveBeenCalledWith('first');
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringMatching(/2 key/));
    expect(h.infoSpy).toHaveBeenCalledWith('  k1 = "v1"');
    expect(h.infoSpy).toHaveBeenCalledWith('  k2 = 42');
  });

  it('configPresetRegisterAction prints the success line on the happy path', async () => {
    const file = join(tmpDir, 'p1.json');
    writeFileSync(file, JSON.stringify({ k1: 'v1' }));
    const client = makeClient({ register: { ok: true, id: 'p1', keyCount: 1 } });
    await configPresetRegisterAction(client, 'p1', { file });
    expect(h.successSpy).toHaveBeenCalledWith('Registered preset "p1" with 1 key(s)');
  });

  it('configPresetApplyAction prints the success line on the happy path and a failure line on partial failure', async () => {
    const okClient = makeClient({ apply: { ok: true, id: 'p1', keyCount: 3 } });
    await configPresetApplyAction(okClient, 'p1');
    expect(h.successSpy).toHaveBeenCalledWith(expect.stringMatching(/Applied preset "p1"/));

    const failClient = makeClient({ apply: { ok: false, id: 'p1', keyCount: 3, failureCount: 1, failures: [{ key: 'k1', status: 'failed', reason: 'boom' }] } });
    await configPresetApplyAction(failClient, 'p1');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/failure\(s\) of 3 key\(s\)/));
    expect(process.exitCode).toBe(1);
  });

  it('configPresetRemoveAction prints the success line', async () => {
    const client = makeClient({ remove: { ok: true, id: 'p1' } });
    await configPresetRemoveAction(client, 'p1');
    expect(h.successSpy).toHaveBeenCalledWith(expect.stringMatching(/Removed preset "p1"/));
  });

  // ── Defensive action paths (missing id, thrown error) ────────────────

  it('configPresetListAction prints the header on the happy path', async () => {
    const client = makeClient({ list: { presets: ['x'] } });
    await configPresetListAction(client);
    expect(h.headerSpy).toHaveBeenCalledWith('Config presets');
  });

  it('configPresetGetAction surfaces thrown errors as non-zero exits', async () => {
    const client = makeClient({ get: new Error('boom') });
    await configPresetGetAction(client, 'p1');
    expect(h.errorSpy).toHaveBeenCalledWith('boom');
    expect(process.exitCode).toBe(1);
  });

  it('configPresetGetAction falls back to String() for non-Error rejections', async () => {
    const client = makeClient({ get: 'plain failure' });
    await configPresetGetAction(client, 'p1');
    expect(h.errorSpy).toHaveBeenCalledWith('plain failure');
    expect(process.exitCode).toBe(1);
  });

  it('configPresetRegisterAction prints usage and sets exitCode=1 when id is empty', async () => {
    const client = makeClient({ register: {} });
    await configPresetRegisterAction(client, '', {});
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
    expect(process.exitCode).toBe(1);
  });

  it('configPresetRegisterAction surfaces thrown errors as non-zero exits', async () => {
    const file = join(tmpDir, 'p1.json');
    writeFileSync(file, JSON.stringify({ k1: 'v1' }));
    const client = makeClient({ register: new Error('disk full') });
    await configPresetRegisterAction(client, 'p1', { file });
    expect(h.errorSpy).toHaveBeenCalledWith('disk full');
    expect(process.exitCode).toBe(1);
  });

  it('configPresetRegisterAction falls back to String() for non-Error rejections', async () => {
    const file = join(tmpDir, 'p2.json');
    writeFileSync(file, JSON.stringify({ k1: 'v1' }));
    const client = makeClient({ register: 'plain failure' });
    await configPresetRegisterAction(client, 'p2', { file });
    expect(h.errorSpy).toHaveBeenCalledWith('plain failure');
    expect(process.exitCode).toBe(1);
  });

  it('configPresetApplyAction prints usage and sets exitCode=1 when id is empty', async () => {
    const client = makeClient({ apply: {} });
    await configPresetApplyAction(client, '');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
    expect(process.exitCode).toBe(1);
  });

  it('configPresetApplyAction surfaces thrown errors as non-zero exits', async () => {
    const client = makeClient({ apply: new Error('timeout') });
    await configPresetApplyAction(client, 'p1');
    expect(h.errorSpy).toHaveBeenCalledWith('timeout');
    expect(process.exitCode).toBe(1);
  });

  it('configPresetApplyAction falls back to String() for non-Error rejections', async () => {
    const client = makeClient({ apply: 'plain failure' });
    await configPresetApplyAction(client, 'p1');
    expect(h.errorSpy).toHaveBeenCalledWith('plain failure');
    expect(process.exitCode).toBe(1);
  });

  it('configPresetApplyAction prints the partial-failure line (failureCount present)', async () => {
    const client = makeClient({
      apply: { ok: false, id: 'p1', keyCount: 3, failureCount: 2, failures: [{ key: 'k1', status: 'failed' }] },
    });
    await configPresetApplyAction(client, 'p1');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/2 failure\(s\) of 3 key\(s\)/));
    expect(process.exitCode).toBe(1);
  });

  it('configPresetApplyAction defaults failureCount to 0 when missing', async () => {
    // No `failureCount` in the response — exercises the `?? 0` fallback.
    const client = makeClient({
      apply: { ok: false, id: 'p1', keyCount: 3, failures: [{ key: 'k1', status: 'failed' }] },
    });
    await configPresetApplyAction(client, 'p1');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/0 failure\(s\) of 3 key\(s\)/));
    expect(process.exitCode).toBe(1);
  });

  it('configPresetGetAction prints the keys list when description is null', async () => {
    const client = makeClient({
      get: { id: 'p1', description: null, values: { k1: 'v1' }, createdAt: '2026-08-29T00:00:00.000Z' },
    });
    await configPresetGetAction(client, 'p1');
    const text = h.infoSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(text).toContain('1 key(s)');
    expect(text).toContain('  k1 = "v1"');
  });

  it('configPresetRemoveAction prints usage and sets exitCode=1 when id is empty', async () => {
    const client = makeClient({ remove: {} });
    await configPresetRemoveAction(client, '');
    expect(h.errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
    expect(process.exitCode).toBe(1);
  });

  it('configPresetRemoveAction surfaces thrown errors as non-zero exits', async () => {
    const client = makeClient({ remove: new Error('denied') });
    await configPresetRemoveAction(client, 'p1');
    expect(h.errorSpy).toHaveBeenCalledWith('denied');
    expect(process.exitCode).toBe(1);
  });

  it('configPresetRemoveAction falls back to String() for non-Error rejections', async () => {
    const client = makeClient({ remove: 'plain failure' });
    await configPresetRemoveAction(client, 'p1');
    expect(h.errorSpy).toHaveBeenCalledWith('plain failure');
    expect(process.exitCode).toBe(1);
  });
});
