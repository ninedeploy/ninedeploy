import { describe, expect, it } from 'vitest';
import {
  hasImportServiceSource,
  importDatabaseVersion,
  importPlan,
  sourceDatabaseHosts,
  type PlanDatabase,
  type PlanRuntime,
  type PlanService,
} from '../src/index.js';

const runtime = (name: string, kind: PlanRuntime['kind'] = 'container'): PlanRuntime => ({ kind, name });
const database = (fields: Partial<PlanDatabase> = {}): PlanDatabase => ({ ref: 'db', name: 'app-db', engine: 'postgres', image: null, issues: [], ...fields });
const service = (create: Partial<PlanService['create']> = {}): PlanService => ({
  ref: 'web', name: 'web', kind: 'image', create: { name: 'web', type: 'docker', ...create }, domains: [], env: [], volumes: [], issues: [],
});

describe('import plan schemas', () => {
  it('reads a version 1 plan, and nothing else', () => {
    const plan = {
      planVersion: 1,
      source: { kind: 'coolify', url: 'https://source.example', version: '4', scope: 'project' },
      generatedAt: '2026-11-24T00:00:00.000Z',
      services: [service({ image: 'nginx:1.27' })],
      databases: [database({ runtime: runtime('app-db') })],
      notes: ['One manual step'],
    };
    expect(importPlan.parse(plan)).toEqual(plan);
    expect(importPlan.safeParse({ ...plan, planVersion: 2 }).success).toBe(false);
    expect(importPlan.safeParse({ ...plan, source: { ...plan.source, kind: 'ansible' } }).success).toBe(false);
    const warning = { level: 'warning', option: 'x', detail: 'y' };
    expect(importPlan.safeParse({ ...plan, services: [{ ...plan.services[0], issues: [warning] }] }).success).toBe(false);
  });

  it('knows whether an item would create a service', () => {
    expect(hasImportServiceSource(service({ image: 'nginx:1.27' }))).toBe(true);
    expect(hasImportServiceSource(service({ repoUrl: 'https://git.example/app.git' }))).toBe(true);
    expect(hasImportServiceSource(service())).toBe(false);
  });

  it("names the hosts an application on the source may use to reach a database", () => {
    expect(sourceDatabaseHosts('coolify', database())).toEqual([]);
    expect(sourceDatabaseHosts('coolify', database({ runtime: runtime('') }))).toEqual([]);
    expect(sourceDatabaseHosts('heroku', database({ runtime: runtime('app', 'heroku-app') }))).toEqual([]);
    expect(sourceDatabaseHosts('dokploy', database({ runtime: runtime('App-DB') }))).toEqual(['app-db']);
    expect(sourceDatabaseHosts('caprover', database({ runtime: runtime('srv-captain--api') }))).toEqual(['api', 'srv-captain--api']);
    expect(sourceDatabaseHosts('caprover', database({ runtime: runtime('plain', 'swarm-service') }))).toEqual(['plain', 'srv-captain--plain']);
  });

  it('keeps a compatible version tag and leaves everything else to the target', () => {
    expect(importDatabaseVersion('postgres', null)).toBeUndefined();
    expect(importDatabaseVersion('postgres', '')).toBeUndefined();
    expect(importDatabaseVersion('postgres', 'postgres')).toBeUndefined();
    expect(importDatabaseVersion('postgres', 'registry.example:5000/postgres')).toBeUndefined();
    expect(importDatabaseVersion('postgres', 'mysql:8.0')).toBeUndefined();
    expect(importDatabaseVersion('postgres', 'postgres:latest')).toBeUndefined();
    expect(importDatabaseVersion('postgres', 'docker.io/library/postgres:16.1')).toBe('16.1');
    expect(importDatabaseVersion('postgres', `library/postgres:16@sha256:${'a'.repeat(64)}`)).toBe('16');
    expect(importDatabaseVersion('mysql', 'mysql:8.0')).toBe('8.0');
    expect(importDatabaseVersion('mariadb', 'mariadb:11')).toBe('11');
    expect(importDatabaseVersion('mongo', 'mongo:7')).toBe('7');
    expect(importDatabaseVersion('redis', 'redis:7.2')).toBe('7.2');
    expect(importDatabaseVersion('keydb', 'eqalpha/keydb:8')).toBe('8');
    expect(importDatabaseVersion('dragonfly', 'ghcr.io/dragonflydb/dragonfly:1.29')).toBe('1.29');
    expect(importDatabaseVersion('clickhouse', 'clickhouse/clickhouse-server:24.8')).toBe('24.8');
  });
});
