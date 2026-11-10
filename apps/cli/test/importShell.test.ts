import { describe, expect, it } from 'vitest';
import { dumpCommand, renderDataPreview } from '../src/commands/importData.js';
import { renderVolumePreview, volumeCommand } from '../src/commands/importVolumes.js';
import { fileBase, flagArg, isPlainName, shellQuote, sourceTarget } from '../src/lib/importers/shell.js';
import type { ImportPlan, PlanDatabase, PlanService } from '../src/lib/importers/plan.js';

/** Names come from the source platform's API and end up in commands a person pastes into a shell. */
const EVIL = 'x$(touch /tmp/pwned);`id`';

describe('shell-safe source commands', () => {
  it('only plain Docker names go into a command', () => {
    expect(isPlainName('srv-captain--pg')).toBe(true);
    expect(isPlainName('k0w8c4.abc_1')).toBe(true);
    for (const bad of [EVIL, 'a b', '-rm', '', "it's", 'a;b', 'a|b']) expect(isPlainName(bad)).toBe(false);
    expect(sourceTarget({ kind: 'container', name: EVIL }, 'the db')).toEqual({ target: '<container>', note: expect.stringContaining('is not a plain Docker name') });
    expect(sourceTarget(undefined, 'the db', true)).toEqual({ target: '<container>', note: 'Replace <container> with the db on the source host (docker ps -a).' });
    expect(sourceTarget({ kind: 'swarm-service', name: 'blog' }, 'x', true).target).toBe('$(docker ps -aq --filter label=com.docker.swarm.service.name=blog | head -n 1)');
    expect(fileBase(EVIL)).toBe('x__touch__tmp_pwned___id_');
    expect(fileBase('..')).toBe('_');
    expect(fileBase('')).toBe('import');
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(flagArg('pg', 'pg.dump')).toBe('pg=pg.dump');
    expect(flagArg('my db', 'my_db.dump')).toBe(`'my db=my_db.dump'`);
  });

  it('keeps a hostile name out of the dump and volume commands and the flag lines', () => {
    const db: PlanDatabase = { ref: 'd', name: EVIL, engine: 'postgres', image: null, runtime: { kind: 'swarm-service', name: EVIL }, issues: [] };
    const cmd = dumpCommand(db)!;
    expect(cmd.command).not.toContain('$(touch');
    expect(cmd.command).toContain('docker exec <container> ');
    const svc: PlanService = {
      ref: 's', name: EVIL, kind: 'image', create: { name: 's', image: 'nginx:1', volumeMount: '/data' } as never, domains: [], env: [],
      volumes: [{ mountPath: '/data', source: 'volume' }], issues: [], runtime: { kind: 'container', name: EVIL },
    };
    const v = volumeCommand(svc) as { command: string };
    expect(v.command).not.toContain('$(touch');
    expect(v.command).not.toContain('`id`');
    const plan: ImportPlan = { planVersion: 1, source: { kind: 'coolify', url: 'http://s', version: null, scope: '' }, generatedAt: '', services: [svc], databases: [db], notes: [] };
    const receipt = { receiptVersion: 1 as const, panel: 'p', source: { kind: 'coolify', url: 'http://s' }, items: {
      'database:d': { kind: 'database' as const, ref: 'd', name: EVIL, state: 'done' as const, id: 1, at: 't', notes: [] },
      'service:s': { kind: 'service' as const, ref: 's', name: EVIL, state: 'done' as const, id: 2, at: 't', notes: [] },
    } };
    const shown = [renderDataPreview(plan, receipt), ...renderVolumePreview(plan, receipt)].join('\n');
    for (const line of shown.split('\n').filter((l) => l.includes('then: --'))) expect(line).toMatch(/then: --(dump|volume) '/);
  });
});
