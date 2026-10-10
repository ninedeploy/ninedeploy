import { dbEngine } from '@ninedeploy/db';
import { createDatabase, DATABASE_IMPORT_ENGINE_OPTIONS, publicAccessEngines } from '@ninedeploy/schemas';
import { describe, expect, it } from 'vitest';
import { ENGINES, studioImageForEngine } from '../../src/engine/database.js';
import {
  DATABASE_ENGINES,
  DUMPABLE_ENGINES,
  NODE_ENGINES_NEEDING_NEWER_AGENT,
  REDIS_FAMILY_ENGINES,
} from '../../src/lib/databaseCommands.js';
import { assertImportEngine } from '../../src/lib/databaseImport.js';
import { assertPublicAccessEngine, publicAccessSupported } from '../../src/lib/publicDatabaseAccess.js';

/**
 * Every place that lists the managed engines must list the same ones. A new
 * engine added to ENGINES but missing from the create schema, the row type,
 * the node builders or the import/public-access tables is the "accepted by
 * the schema, consumed by nothing" defect this repo keeps having
 * (0.15.6: keydb and dragonfly).
 */
describe('the engine lists agree', () => {
  const engines = Object.keys(ENGINES).sort();

  it('ENGINES, the node/agent builders, the row type and the create schema list the same engines', () => {
    expect([...DATABASE_ENGINES].sort()).toEqual(engines);
    expect([...dbEngine].sort()).toEqual(engines);
    expect([...createDatabase.shape.engine.options].sort()).toEqual(engines);
  });

  it('every dumpable, importable, public-access and Redis-family engine is a known engine', () => {
    for (const engine of DUMPABLE_ENGINES) expect(engines).toContain(engine);
    for (const engine of Object.keys(DATABASE_IMPORT_ENGINE_OPTIONS)) expect(engines).toContain(engine);
    for (const engine of publicAccessEngines) expect(engines).toContain(engine);
    for (const engine of REDIS_FAMILY_ENGINES) expect(engines).toContain(engine);
    for (const engine of NODE_ENGINES_NEEDING_NEWER_AGENT) expect(engines).toContain(engine);
  });

  it('the Redis family is wired everywhere the originals are', () => {
    for (const engine of REDIS_FAMILY_ENGINES) {
      const cfg = ENGINES[engine]!;
      expect(cfg.port, engine).toBe(6379);
      expect(cfg.volumePath, engine).toBe('/data');
      expect(cfg.authViaArg, engine).toBe(true);
      expect(cfg.username(), engine).toBeUndefined();
      expect(cfg.dbName(), engine).toBeUndefined();
      expect(DUMPABLE_ENGINES.has(engine), engine).toBe(true);
      expect(DATABASE_IMPORT_ENGINE_OPTIONS[engine as 'redis'], engine).toEqual(['confirmReplace', 'skipSafetyBackup']);
      expect(() => assertImportEngine(engine), engine).not.toThrow();
      expect(publicAccessSupported(engine), engine).toBe(true);
      expect(() => assertPublicAccessEngine(engine, 'terminate'), engine).not.toThrow();
      expect(studioImageForEngine(engine).containerPort, engine).toBe(8081);
    }
  });

  it('no engine image is floating', () => {
    for (const [name, cfg] of Object.entries(ENGINES)) {
      if (name === 'postgres') continue; // `postgres:18`: a major, as before
      expect(cfg.image(), name).not.toMatch(/:latest$/);
      expect(cfg.image(), name).toMatch(/:[^:/]+$/);
    }
  });
});
