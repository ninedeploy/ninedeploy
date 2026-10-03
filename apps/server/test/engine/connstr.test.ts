/**
 * Regression test: ENGINES connectionString must return real URIs, not placeholder literals.
 *
 * Three engines (MySQL, PostgreSQL, Redis) were found to contain broken
 * backtick-enclosed placeholder strings instead of real template-literal URI builders.
 * Services depending on those database engines would receive "[REDACTED:xxx_uri]" as
 * their connection string at runtime and fail to connect.
 */
import { describe, it, expect } from 'vitest';
import { ENGINES } from '../../src/engine/database.js';

function enc(s: string): string {
  return encodeURIComponent(s);
}

describe('ENGINES connectionString — no placeholder literals', () => {
  const CASES: Array<{
    engine: keyof typeof ENGINES;
    h: string;
    prt: number;
    u: string;
    p: string;
    d?: string;
    scheme: string;
  }> = [
    { engine: 'mysql',    h: 'mysql-host',  prt: 3306, u: 'root', p: 't3st!', d: 'app', scheme: 'mysql://' },
    { engine: 'postgres', h: 'pg-host',     prt: 5432, u: 'nine', p: 't3st!', d: 'app', scheme: 'postgres://' },
    { engine: 'redis',   h: 'redis-host',   prt: 6379, u: '',    p: 't3st!',          scheme: 'redis://' },
    { engine: 'mariadb',  h: 'maria-host',   prt: 3306, u: 'root', p: 't3st!', d: 'app', scheme: 'mariadb://' },
    { engine: 'valkey',   h: 'valkey-host',  prt: 6379, u: '',    p: 't3st!',          scheme: 'valkey://' },
    { engine: 'clickhouse', h: 'ch-host',   prt: 8123, u: 'nine', p: 't3st!', d: 'app', scheme: 'clickhouse://' },
    { engine: 'meilisearch', h: 'mei-host', prt: 7700, u: '',    p: 't3st!',          scheme: 'http://' },
    { engine: 'rabbitmq', h: 'rmq-host',    prt: 5672, u: 'nine', p: 't3st!',          scheme: 'amqp://' },
    { engine: 'mongo',    h: 'mongo-host',  prt: 27017, u: 'nine', p: 't3st!',         scheme: 'mongodb://' },
  ];

  for (const tc of CASES) {
    it(`${tc.engine}: returns a real connection URI, not a placeholder`, () => {
      const cfg = ENGINES[tc.engine];
      // @ts-expect-error – different engines have slightly different signatures; test covers real call sites
      const result = cfg.connectionString(tc.h, tc.prt, tc.u, tc.p, tc.d ?? undefined);

      // The critical check: must NOT be a broken placeholder literal.
      const isPlaceholder = typeof result === 'string' && result.startsWith('[REDACTED:');
      expect(isPlaceholder, [
        `BUG: ${tc.engine} connectionString returned placeholder "${result}"`,
        'Expected a real URI, got a literal placeholder.',
        'This means services deployed with this database engine cannot obtain a valid',
        'connection string and will fail at runtime.',
      ].join('\n')).toBe(false);

      // Sanity: URL must start with the correct scheme and contain our test values.
      expect(result).toContain(tc.h);
      expect(result).toContain(enc(tc.p));
      expect(result.startsWith(tc.scheme),
        `Expected URI to start with "${tc.scheme}", got "${result}"`,
      ).toBe(true);
    });
  }
});
