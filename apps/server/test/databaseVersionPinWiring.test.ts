/**
 * Wiring guard for the database version pin (lib/databaseVersionPin.ts):
 *  - the database-imports plugin runs the pin at boot, and only then upgrade
 *    recovery, which starts databases;
 *  - every place that inserts a database row sets `version`, so no new row
 *    is left following the moving engine default.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const order: string[] = [];
let releasePin: () => void = () => undefined;
vi.mock('../src/lib/databaseVersionPin.js', () => ({
  pinUnversionedDatabases: vi.fn(() => new Promise((resolve) => {
    order.push('pin');
    releasePin = () => resolve({ pinned: 0, left: 0 });
  })),
}));
vi.mock('../src/lib/databaseUpgrade.js', () => ({
  recoverInterruptedUpgrades: vi.fn(async () => { order.push('recover'); return 0; }),
  pruneFinishedUpgrades: vi.fn(async () => 0),
}));

const plugin = (await import('../src/plugins/databaseImports.js')).default;
const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

describe('database version pin wiring', () => {
  it('pins at boot without holding it up, and recovers upgrades only after the pin', async () => {
    const app = Fastify();
    await app.register(plugin, { intervalMs: 60_000 });
    await app.ready();
    await vi.waitFor(() => expect(order).toContain('pin'));
    expect(order).not.toContain('recover');
    releasePin();
    await vi.waitFor(() => expect(order).toEqual(['pin', 'recover']));
    await app.close();
  });

  it('every insert of a database row sets its version', () => {
    const sites: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      let at = text.indexOf('insert(databases)');
      while (at !== -1) {
        const values = text.indexOf('.values(', at);
        const end = text.indexOf('.returning(', values);
        const body = text.slice(values, end === -1 ? values + 2000 : end);
        const where = `${path.relative(SRC, file)}:${text.slice(0, at).split('\n').length}`;
        sites.push(where);
        expect(body.includes('version:') || body.includes('version,'), `${where} inserts a database without a version`).toBe(true);
        at = text.indexOf('insert(databases)', at + 1);
      }
    }
    // modules/databases.ts (twice), templateDependencies, preview copies, PITR recovery.
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });
});
