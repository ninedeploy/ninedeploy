import { writeFile } from 'node:fs/promises';
import { createDb, runMigrations, services, metrics } from '@ninedeploy/db';
import { observabilityDb } from './observability.js';
import { shipLogsOnce, type ShipperDeps } from '../../src/engine/logShipper.js';
import { persistServiceMetrics, pruneServiceMetrics, readMetricPoints } from '../../src/lib/serviceMetricHistory.js';

const [mode, url, report] = process.argv.slice(2);
if (!mode || !url || !report) throw new Error('Expected fixture mode, database URL and report file');
const now = new Date('2026-10-22T15:00:00Z');
if (mode === 'capture' || mode === 'metrics-write') {
  const f = await observabilityDb(url);
  try {
    if (mode === 'capture') {
      const { logDrains } = await import('@ninedeploy/db');
      await f.db.insert(logDrains).values({ name: 'receiver', url: 'https://logs.example/ingest' });
      let clock = now;
      const deps: ShipperDeps = {
        readLogs: async () => ['2026-10-22T15:00:01Z persisted log'],
        dispatch: async () => ({ ok: false, status: 503 }), now: () => clock,
      };
      await shipLogsOnce(f.db, deps); clock = new Date('2026-10-22T15:00:02Z'); const result = await shipLogsOnce(f.db, deps);
      await f.db.update(services).set({ status: 'stopped' });
      await writeFile(report, JSON.stringify(result));
    } else {
      await f.configure({ retentionDays: 30 });
      await persistServiceMetrics(f.db, [{ serviceId: 1, kind: 'cpu', value: 250, ts: new Date('2026-10-12T15:00:00Z') }]);
      await pruneServiceMetrics(f.db, now);
      await writeFile(report, JSON.stringify({ rawRows: (await f.db.select().from(metrics)).length }));
    }
  } finally { f.close(); }
} else {
  const f = createDb({ url }); await f.ready; await runMigrations(f.db);
  try {
    if (mode === 'deliver') {
      const entries: string[] = [];
      const result = await shipLogsOnce(f.db, {
        readLogs: async () => { throw new Error('Stopped source must not be read'); },
        dispatch: async (_target, lines) => { entries.push(...lines.map((e) => e.line)); return { ok: true, status: 204 }; },
        now: () => new Date('2026-10-22T15:01:00Z'),
      });
      await writeFile(report, JSON.stringify({ ...result, entries }));
    } else if (mode === 'metrics-read') {
      await writeFile(report, JSON.stringify(await readMetricPoints(f.db, 1, 'cpu', 30 * 1440, now)));
    } else throw new Error('Unknown fixture mode');
  } finally { f.client!.close(); }
}
