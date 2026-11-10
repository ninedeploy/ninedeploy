import { describe, expect, it } from 'vitest';
import { envFileEntries, findConnections, sourceHosts } from '../src/lib/importers/connections.js';
import type { ImportPlan, PlanDatabase, PlanEngine, SourceKind } from '../src/lib/importers/plan.js';

const db = (name: string, engine: PlanEngine | null, runtime?: string): PlanDatabase => ({
  ref: name, name, engine, image: null, ...(runtime ? { runtime: { kind: 'swarm-service' as const, name: runtime } } : {}), issues: [],
});
const plan = (databases: PlanDatabase[], kind: SourceKind = 'caprover', url = 'https://captain.old.example'): ImportPlan => ({
  planVersion: 1, source: { kind, url, version: null, scope: '' }, generatedAt: '', services: [], databases, notes: [],
});
const SECRET = 'SENTINEL-x';

describe('sourceHosts', () => {
  it('knows both CapRover names, and the runtime name elsewhere', () => {
    expect(sourceHosts('caprover', db('pg', 'postgres', 'pg'))).toEqual(['pg', 'srv-captain--pg']);
    expect(sourceHosts('caprover', db('pg', 'postgres', 'srv-captain--Pg'))).toEqual(['pg', 'srv-captain--pg']);
    expect(sourceHosts('coolify', db('pg', 'postgres', 'k0w8c4'))).toEqual(['k0w8c4']);
    expect(sourceHosts('dokploy', db('pg', 'postgres'))).toEqual([]);
  });
});

describe('envFileEntries', () => {
  it('reads plain, quoted and exported values, and drops trailing comments', () => {
    expect(envFileEntries('A=1\nexport B="x # y"\nC=\'q\'\nD=v # note\n# E=no\nbad line\nF=')).toEqual([
      { key: 'A', value: '1' }, { key: 'B', value: 'x # y' }, { key: 'C', value: 'q' }, { key: 'D', value: 'v' }, { key: 'F', value: '' },
    ]);
  });
});

describe('findConnections', () => {
  const p = plan([db('pg', 'postgres', 'pg'), db('cache', 'redis', 'cache'), db('docs', 'mongo', 'docs'), db('my', 'mysql', 'my'), db('maria', 'mariadb', 'maria'), db('ch', 'clickhouse', 'ch'), db('odd', null, 'odd')]);
  const env = [
    `DATABASE_URL=postgres://${SECRET}:${SECRET}@srv-captain--pg:5432/shop`,
    `PG_SSL=postgres://u:${SECRET}@pg:5432/shop?sslmode=require`,
    `PRISMA=postgresql://u:${SECRET}@pg:5432/shop`,
    `REDIS_URL=redis://:${SECRET}@srv-captain--cache:6379`,
    `REDIS_DB2=redis://:${SECRET}@cache:6379/2`,
    `MONGO=mongodb://u:${SECRET}@docs:27017/app?authSource=admin`,
    `MYSQL_URL=mysql://u:${SECRET}@my:3306/shop`,
    `MARIA_URL=mysql://u:${SECRET}@maria:3306/shop`,
    `CH=clickhouse://u:${SECRET}@ch:9000/x`,
    `ODD=thing://u:${SECRET}@odd:1/x`,
    'DB_HOST=srv-captain--pg',
    'DB_HOSTPORT=pg:5432',
    `OLD=postgres://u:${SECRET}@captain.old.example:5432/shop`,
    'OLD_HOST=captain.old.example',
    'API=https://captain.old.example/api',
    'NOTHING=elsewhere.example',
    'EMPTY=',
  ].join('\n');
  const hits = findConnections(p, env);
  const by = Object.fromEntries(hits.map((h) => [h.key, h]));

  it('attaches only where the panel\'s string replaces the value exactly', () => {
    expect(hits.filter((h) => h.action === 'attach').map((h) => [h.key, h.database!.name, h.host])).toEqual([
      ['DATABASE_URL', 'pg', 'srv-captain--pg'], ['REDIS_URL', 'cache', 'srv-captain--cache'], ['MYSQL_URL', 'my', 'my'],
    ]);
  });

  it('says why the rest need a person', () => {
    expect(by.PG_SSL!.reason).toMatch(/carries options/);
    expect(by.PRISMA!.reason).toMatch(/starts with postgres:\/\/ and this one with postgresql:\/\//);
    expect(by.REDIS_DB2!.reason).toMatch(/Redis database 2/);
    expect(by.MONGO!.reason).toMatch(/names no database/);
    expect(by.MARIA_URL!.reason).toMatch(/starts with mariadb:\/\//);
    expect(by.CH!.reason).toMatch(/ClickHouse/);
    expect(by.ODD!.reason).toMatch(/no managed equivalent/);
    expect(by.DB_HOST).toMatchObject({ action: 'manual', host: 'srv-captain--pg' });
    expect(by.DB_HOSTPORT).toMatchObject({ action: 'manual', host: 'pg' });
    expect(by.OLD).toMatchObject({ action: 'manual', database: null });
    expect(by.OLD!.reason).toMatch(/NineDeploy can still reach that host, so the app would keep using the old database/);
    expect(by.OLD_HOST).toMatchObject({ action: 'manual', database: null });
    expect(by.API).toBeUndefined();
    expect(by.NOTHING).toBeUndefined();
    expect(by.EMPTY).toBeUndefined();
  });

  it('never carries a value', () => {
    expect(JSON.stringify(hits)).not.toContain(SECRET);
  });

  it('copes with a source URL it cannot parse, and a value that only looks like a URL', () => {
    expect(findConnections(plan([db('pg', 'postgres', 'pg')], 'caprover', 'not a url'), 'A=x://[bad\nB=pg')).toEqual([
      expect.objectContaining({ key: 'B', action: 'manual' }),
    ]);
  });
});
