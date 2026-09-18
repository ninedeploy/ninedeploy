/**
 * r185 — wiring guard. In Fastify a plugin-level `addHook` applies to EVERY
 * route of that plugin, including routes declared ABOVE it. Code written as
 * "public route, then `app.addHook(authenticate)`, then private routes" gates
 * the public one too; it bit pgbouncer (members 403 on status),
 * domainTransfers (logged-out preview 401) and emailTemplates (reads
 * operator-only). Put guarded routes in a nested `app.register` instead.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MODULES = fileURLToPath(new URL('../src/modules', import.meta.url));

/** The exported plugin a line belongs to (nearest preceding top-level export). */
function ownerOf(lines: string[], i: number): string {
  for (let j = i; j >= 0; j--) {
    const m = /^export const (\w+)/.exec(lines[j]!);
    if (m) return m[1]!;
  }
  return '';
}

describe('r185: no plugin-level hook after a route of the same plugin', () => {
  it('finds none', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(MODULES).filter((n) => n.endsWith('.ts'))) {
      const lines = readFileSync(path.join(MODULES, name), 'utf8').split('\n');
      const routeOwners = new Set<string>();
      lines.forEach((line, i) => {
        if (/^ {2}app\.(get|post|put|patch|delete|route)[<(]/.test(line)) routeOwners.add(ownerOf(lines, i));
        if (/^ {2}app\.addHook\(\s*'(onRequest|preValidation|preHandler)'/.test(line) && routeOwners.has(ownerOf(lines, i))) {
          offenders.push(`${name}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
