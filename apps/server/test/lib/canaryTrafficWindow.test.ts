import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CANARY_TRAFFIC_MAX_BYTES, CANARY_TRAFFIC_MAX_LINE, CANARY_TRAFFIC_MAX_RECORDS, CANARY_TRAFFIC_MAX_WINDOWS,
  openFileCanaryTraffic, type FileCanaryTrafficObservation,
  hasCanaryTrafficWindow, invalidateCanaryTrafficWindows,
} from '../../src/lib/canaryTrafficWindow.js';

let dir: string, file: string;
const windows: FileCanaryTrafficObservation[] = [];
const event = (over: Record<string, unknown> = {}) => `${JSON.stringify({
  ServiceName: 'svc_web_4_canary@file', StartUTC: '2026-10-24T00:00:00Z', DownstreamStatus: 200, Duration: 10_000_000, ...over,
})}\n`;
const begin = async (over: Partial<Parameters<typeof openFileCanaryTraffic>[0]> = {}) => {
  const window = await openFileCanaryTraffic({ file, slug: 'web', identity: async () => 'proxy-start-1', ...over });
  windows.push(window); return window;
};
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'nd-canary-window-')); file = path.join(dir, 'access.log'); await writeFile(file, ''); });
afterEach(async () => { await Promise.all(windows.splice(0).map(w => w.close())); await rm(dir, { recursive: true, force: true }); });

describe('source-bound canary traffic window', () => {
  it('is invalidated before an owner truncates and regrows identical log bytes', async () => {
    await writeFile(file, event()); const window = await begin();
    expect(hasCanaryTrafficWindow(file)).toBe(true);
    invalidateCanaryTrafficWindows(file);
    await truncate(file, 0); await writeFile(file, event() + event());
    await expect(window.finish()).rejects.toThrow(/closed/);
    await window.close(); expect(hasCanaryTrafficWindow(file)).toBe(false);
  });
  it('ignores the previous step and drains the final append without an analytics-tail tick', async () => {
    await writeFile(file, event({ DownstreamStatus: 503 }));
    const window = await begin();
    await appendFile(file, event() + event({ ServiceName: 'svc_web_4_stable@file', Duration: 20_000_000 }));
    expect(await window.sample()).toMatchObject({ complete: false, canary: { requests: 1, errors: 0, p95Ms: 10 }, stable: { requests: 1, errors: 0, p95Ms: 20 } });
    await appendFile(file, event({ DownstreamStatus: 503, Duration: 90_000_000 }));
    const final = await window.finish();
    expect(final).toMatchObject({ complete: true, canary: { requests: 2, errors: 1, errorRate: 50, p95Ms: 90 } });
    expect(final.receipt.sourceId).toMatch(/^[a-f0-9]{64}$/);
    expect(final.receipt.fromOffset).toBe(Buffer.byteLength(event({ DownstreamStatus: 503 })));
    expect(final.receipt.toOffset - final.receipt.fromOffset).toBe(final.receipt.bytes);
    await expect(window.sample()).rejects.toThrow(/closed/);
  });

  it('attributes exact service leaves and counts completions independently of host clocks', async () => {
    const window = await begin();
    await appendFile(file, event({ ServiceName: 'svc_web-other_4_canary@file' }) + event({ ServiceName: 'svc_web_4_canary@docker' }) +
      event({ StartUTC: '2030-01-01T00:00:00Z' }) + event({ ServiceName: 'svc_web_9_stable@file', StartUTC: '2020-01-01T00:00:00Z' }));
    expect(await window.finish()).toMatchObject({ complete: true, canary: { requests: 1 }, stable: { requests: 1 } });
  });

  it('reassembles a record that was partially appended when the window opened', async () => {
    const row = event({ DownstreamStatus: 503 });
    await writeFile(file, row.slice(0, 41));
    const window = await begin();
    await appendFile(file, row.slice(41));
    expect(await window.finish()).toMatchObject({ complete: true, canary: { requests: 1, errors: 1 } });
  });

  it('retains a partial record between samples and refuses an incomplete final verdict', async () => {
    const window = await begin();
    await appendFile(file, event().slice(0, 35));
    expect(await window.sample()).toMatchObject({ complete: false, canary: { requests: 0 } });
    await expect(window.finish()).rejects.toThrow(/incomplete/);
    await appendFile(file, event().slice(35));
    await expect(window.sample()).rejects.toThrow(/closed/);
  });

  it('records an actual empty window with an attested receipt', async () => {
    const result = await (await begin()).finish();
    expect(result).toMatchObject({ complete: true, canary: { requests: 0, errorRate: null, p95Ms: null }, receipt: { bytes: 0, records: 0 } });
  });

  it('does not return private event fields or malformed input in errors', async () => {
    const window = await begin();
    await appendFile(file, event({ privateHeader: 'private-marker' }));
    expect(JSON.stringify(await window.sample())).not.toContain('private-marker');
    await appendFile(file, 'private-malformed-marker\n');
    await expect(window.finish()).rejects.toThrow('malformed log record');
    await expect(window.sample()).rejects.not.toThrow('private-malformed-marker');
  });

  it.each([
    { StartUTC: null }, { Duration: null }, { Duration: -1 }, { Duration: 1.5 },
    { DownstreamStatus: 0 }, { DownstreamStatus: 600 }, { ServiceName: null },
  ])('refuses an incomplete or unsupported response %j', async over => {
    const window = await begin(); await appendFile(file, event(over));
    await expect(window.finish()).rejects.toThrow(/incomplete|missing/);
  });

  it('ignores a valid unmatched client request without manufacturing service hits', async () => {
    const window = await begin();
    await appendFile(file, event({ ServiceName: null, DownstreamStatus: 404 }));
    expect(await window.finish()).toMatchObject({ complete: true, canary: { requests: 0 } });
  });

  it('refuses a missing or symlinked log instead of returning empty traffic', async () => {
    await rm(file); await expect(begin()).rejects.toThrow(/could not be opened/);
    const real = path.join(dir, 'real.log'); await writeFile(real, ''); await symlink(real, file, 'file');
    await expect(begin()).rejects.toThrow(/could not be opened|identity/);
  });

  it('refuses log rotation and replacement while retaining the original descriptor', async () => {
    const window = await begin();
    await rename(file, `${file}.old`); await writeFile(file, event());
    await expect(window.finish()).rejects.toThrow(/rotated/);
  });

  it('refuses truncation and truncate/regrow with the same inode', async () => {
    await writeFile(file, event()); const first = await begin();
    await truncate(file, 0); await expect(first.finish()).rejects.toThrow(/truncated/);
    await writeFile(file, event()); const second = await begin();
    await writeFile(file, 'x'.repeat(Buffer.byteLength(event()) + 100));
    await expect(second.finish()).rejects.toThrow(/rewritten/);
  });

  it('refuses a replaced proxy before reading and a late identity change after reading', async () => {
    let identity = 'proxy1'; const first = await begin({ identity: async () => identity });
    identity = 'proxy2'; await expect(first.finish()).rejects.toThrow(/replaced/);
    let calls = 0;
    const second = await begin({ identity: async () => ++calls >= 4 ? 'proxy2' : 'proxy1' });
    await appendFile(file, event());
    await expect(second.finish()).rejects.toThrow(/replaced/);
  });

  it('does not deliver a late snapshot after close', async () => {
    let calls = 0, release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const window = await begin({ identity: async () => { if (++calls >= 3) await gate; return 'proxy1'; } });
    const reading = window.finish();
    await window.close(); release();
    await expect(reading).rejects.toThrow(/closed|could not be read/);
  });

  it('bounds total bytes, line size, record count and lifetime', async () => {
    const bytes = await begin(); await truncate(file, CANARY_TRAFFIC_MAX_BYTES + 1);
    await expect(bytes.finish()).rejects.toThrow(/byte limit/); await truncate(file, 0);
    const line = await begin(); await appendFile(file, 'x'.repeat(CANARY_TRAFFIC_MAX_LINE + 1));
    await expect(line.finish()).rejects.toThrow(/oversized/); await truncate(file, 0);
    const count = await begin(); await appendFile(file, event().repeat(CANARY_TRAFFIC_MAX_RECORDS + 1));
    await expect(count.finish()).rejects.toThrow(/record limit/); await truncate(file, 0);
    let now = 0; const age = await begin({ now: () => now, maxAgeMs: 50 }); now = 51;
    await expect(age.finish()).rejects.toThrow(/expired/);
  });

  it('bounds concurrent open windows and releases reservations after failures and close', async () => {
    const opened = await Promise.all(Array.from({ length: CANARY_TRAFFIC_MAX_WINDOWS }, () => begin()));
    await expect(begin()).rejects.toThrow(/too many/);
    await opened[0]!.close(); await begin();
    await opened[1]!.close();
    await expect(begin({ identity: async () => { throw new Error('private upstream path'); } })).rejects.toThrow(/could not be opened/);
    await begin();
  });
});
