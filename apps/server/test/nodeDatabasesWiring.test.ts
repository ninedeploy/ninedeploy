import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Multi-node T6, mount points M17/M18 (design §9): each wiring fails here if
 * it is removed — the runtime dispatch at every caller of a database
 * operation, the D4 connect in the docker builder, the O7 bridge join in the
 * pipeline, the status plugin's timer, and the refusals on the panel-only
 * features. (The agent registry, the stream kinds and the server delete hook
 * are asserted in agentOpsDatabases, agentMultiNode and multiNodeWiring.)
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('the runtime dispatch reaches every caller (M17)', () => {
  const callers: Array<[string, RegExp[], RegExp[]]> = [
    // [file, must contain, must NOT contain]
    ['../src/modules/backups.ts', [/databaseRuntime\(app\.db, d\)\.size\(\)/, /databaseRuntime\(app\.db, d\)\.backup\(file, log\)/, /databaseRuntime\(app\.db, d\)\.restore\(restorePath, log\)/], [/\bbackupDatabase\(/, /\brestoreDatabase\(/, /\bdatabaseSize\(/]],
    ['../src/plugins/backupScheduler.ts', [/databaseRuntime\(fastify\.db, d\)\.backup\(file, log\)/], [/\bbackupDatabase\(/]],
    ['../src/lib/databaseImport.ts', [/databaseRuntime\(db, d\)\.import\(file, plan, log\)/, /databaseRuntime\(db, d\)\.probeCredentials\(\)/], [/\bimportDatabase\(/, /\bprobeDatabaseCredentials\(/]],
    ['../src/modules/databaseImports.ts', [/databaseRuntime\(app\.db, d\)\.probeMysqlSandboxFlag\(\)/, /databaseContainerName\(d\)/], [/\bprobeMysqlSandboxFlag\(d\)/]],
    ['../src/engine/templateDependencies.ts', [/databaseRuntime\(db, database\)/, /runtime\.start\(log, \{ labels/], [/\bstartDatabase\(/, /\battachDatabaseToServiceBridges\(/]],
    ['../src/modules/databases.ts', [/databaseRuntime\(app\.db, d\)\.restart\(/, /databaseRuntime\(app\.db, d\)\.stop\(/, /databaseRuntime\(app\.db, d\)\.logs\(lines\)/, /const runtime = databaseRuntime\(app\.db, updated\)/, /nodeDatabaseRuntime\(app\.db, row\)/, /refuseOnNode\(d, 'Web Studio'\)/], [/\brestartDatabase\(/, /\bdatabaseLogs\(/]],
    ['../src/modules/terminals.ts', [/if \(d\.serverId != null\) \{/, /assertNodeTerminal\(d\.serverId, false\)/], []],
    ['../src/modules/pgbouncer.ts', [/if \(d\.serverId != null\) \{\r?\n\s+throw unprocessable\([^)]*'remote_database'\)/], []],
    ['../src/lib/publicDatabaseAccess.ts', [/if \(d\.serverId != null\) \{\r?\n\s+throw unprocessable\([^)]*'remote_database'\)/], []],
  ];
  for (const [file, must, mustNot] of callers) {
    it(file.replace('../src/', ''), () => {
      const src = read(file);
      for (const re of must) expect(src, String(re)).toMatch(re);
      for (const re of mustNot) expect(src, String(re)).not.toMatch(re);
    });
  }

  it('D4: the docker builder connects ctx.databaseContainers to the service bridge before the run; the pipeline fills it', () => {
    const builder = read('../src/engine/builders/docker.ts');
    const connect = builder.indexOf('for (const container of ctx.databaseContainers ?? [])');
    expect(connect).toBeGreaterThan(builder.indexOf('const bridge = await ensureServiceBridge(service.slug, log);'));
    expect(connect).toBeLessThan(builder.indexOf("const args = ['run', '-d', '--name', name"));
    const pipeline = read('../src/engine/pipeline.ts');
    expect(pipeline).toMatch(/databaseContainers:\r?\n\s+service\.serverId == null\r?\n\s+\? runtimeEnvironment\.attachedDatabases/);
  });

  it('O7: the pipeline joins a node service to its same-node database bridges between the run and the healthcheck', () => {
    const pipeline = read('../src/engine/pipeline.ts');
    const join = pipeline.indexOf('await connectServiceToNodeDatabases(db, service.serverId, runtime.runtimeId, onNode, log);');
    expect(join).toBeGreaterThan(pipeline.indexOf('runtime = await builder.buildAndRun(ctx, previous);'));
    expect(join).toBeLessThan(pipeline.indexOf("const healthy = await builder.isHealthy(runtime, 300_000, 10_000, log);"));
  });

  it('D5: a sidecar publishes only a non-default port', () => {
    expect(read('../src/lib/pgbouncer.ts')).toMatch(/\.\.\.\(port !== DEFAULT_PORT \? \['-p', `127\.0\.0\.1:\$\{port\}:\$\{port\}`\] : \[\]\)/);
  });
});

describe('the status plugin (M2 filled by T6)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('sweeps every 60 s once ready, and stops on close', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => []);
    vi.doMock('../src/lib/nodeDatabase.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/lib/nodeDatabase.js')>()) }));
    const mod = await import('../src/plugins/nodeDatabases.js');
    const db = { select: () => ({ from: () => ({ where: async () => { sweep(); return []; } }) }) };
    const app = Fastify({ logger: false });
    app.decorate('db', db as never);
    await app.register(mod.default);
    await app.ready();
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    await app.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('app.ts registers it after the kernel plugin', () => {
    const app = read('../src/app.ts');
    const at = app.search(/register\(nodeDatabasesPlugin/);
    expect(at).toBeGreaterThan(app.search(/register\(kernelPlugin/));
  });
});
