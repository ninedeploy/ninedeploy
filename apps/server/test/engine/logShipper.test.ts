import { describe, expect, it, vi } from 'vitest';
import { parseDockerLogLine, shipLogsOnce, type ShipperCursors } from '../../src/engine/logShipper.js';
import { formatLogBatch } from '../../src/engine/logDrainManager.js';
import { createFakeDb, svcRow } from '../helpers.js';

vi.mock('../../src/lib/crypto.js', () => ({ decrypt: (v: string) => `dec:${v}` }));

const drain = (over: Record<string, unknown> = {}) => ({
  id: 1, name: 'loki', type: 'loki', url: 'https://loki.example', apiKeyEncrypted: null,
  serviceId: null, enabled: true, format: 'json', headersJson: null, ...over,
});

function setup(rows: { drains: unknown[]; services: unknown[] }) {
  const db = createFakeDb({ select: { logDrains: rows.drains as never, services: rows.services as never } });
  const readLogs = vi.fn(async () => [] as string[]);
  const dispatch = vi.fn(async () => ({ ok: true, status: 204 }));
  const now = () => new Date('2026-09-18T10:00:00.000Z');
  return { db, deps: { readLogs, dispatch, now }, readLogs, dispatch };
}

describe('log-drain shipper (r231)', () => {
  it('parses docker --timestamps lines', () => {
    expect(parseDockerLogLine('2026-09-18T10:00:01.123456789Z hello world')).toEqual({
      ts: '2026-09-18T10:00:01.123456789Z', line: 'hello world',
    });
    expect(parseDockerLogLine('no timestamp')).toBeNull();
  });

  it('starts at first sight (no backfill), then forwards only new lines to covering drains', async () => {
    const { db, deps, readLogs, dispatch } = setup({
      drains: [drain(), drain({ id: 2, serviceId: 99 })],
      services: [svcRow({ id: 1, slug: 'web', status: 'running', type: 'docker', runtimeId: 'web-1-7', replicas: 1, serverId: null })],
    });
    const cursors: ShipperCursors = new Map();
    await shipLogsOnce(db as never, cursors, deps);
    expect(readLogs).not.toHaveBeenCalled();
    expect(cursors.get('web-1-7')).toBe('2026-09-18T10:00:00.000Z');

    readLogs.mockResolvedValueOnce([
      '2026-09-18T10:00:00.000Z already sent (inclusive --since)',
      '2026-09-18T10:00:02.000000001Z GET / 200',
      '2026-09-18T10:00:03.000000001Z GET /health 200',
    ]);
    const res = await shipLogsOnce(db as never, cursors, deps);
    expect(readLogs).toHaveBeenCalledWith('web-1-7', '2026-09-18T10:00:00.000Z');
    // Drain 2 is scoped to another service: only drain 1 receives the batch.
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [target, entries] = dispatch.mock.calls[0] as unknown as [{ url: string }, Array<{ line: string; service: string }>];
    expect(target.url).toBe('https://loki.example');
    expect(entries.map((e) => e.line)).toEqual(['GET / 200', 'GET /health 200']);
    expect(entries[0]!.service).toBe('web');
    expect(res).toEqual({ shipped: 2, failed: 0 });
    expect(cursors.get('web-1-7')).toBe('2026-09-18T10:00:03.000000001Z');
  });

  it('does nothing (and forgets cursors) with no enabled drain', async () => {
    const { db, deps, readLogs } = setup({ drains: [], services: [] });
    const cursors: ShipperCursors = new Map([['x', 'y']]);
    await shipLogsOnce(db as never, cursors, deps);
    expect(readLogs).not.toHaveBeenCalled();
    expect(cursors.size).toBe(0);
  });

  it('labels Loki streams the way log search queries them', () => {
    const body = JSON.parse(
      formatLogBatch('loki', 'json', [
        { timestamp: '2026-09-18T10:00:02Z', service: 'web', container: 'web-1-7', line: 'a' },
        { timestamp: '2026-09-18T10:00:03Z', service: 'web', container: 'web-1-7', line: 'b' },
      ]).body,
    ) as { streams: Array<{ stream: Record<string, string>; values: string[][] }> };
    expect(body.streams).toHaveLength(1);
    // lib/logSearch.ts: {service="<slug>"} per service, {job="ninedeploy"} cluster-wide.
    expect(body.streams[0]!.stream).toMatchObject({ service: 'web', job: 'ninedeploy' });
    expect(body.streams[0]!.values.map((v) => v[1])).toEqual(['a', 'b']);
  });
});
