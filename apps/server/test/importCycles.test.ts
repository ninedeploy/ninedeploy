import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NETWORK, TRAEFIK_CONTAINER, TRAEFIK_IMAGE } from '../src/engine/dockerNames.js';
import * as proxy from '../src/engine/proxy.js';
import { RESERVED_NETWORKS } from '../src/lib/serviceBridge.js';

/**
 * Guard against ESM import cycles in the server's own modules.
 *
 * `engine/proxy.ts` and `lib/serviceBridge.ts` used to import each other, and
 * `serviceBridge` evaluates `RESERVED_NETWORKS = [NETWORK]` at module scope.
 * Whichever of the two Node reached first decided whether the constant was
 * initialised yet, and the real entry graph reached `proxy` first — so every
 * production boot died with
 *
 *   ReferenceError: Cannot access 'NETWORK' before initialization
 *
 * while `tsc` reported no error and the test suites (which import the modules
 * in the safe order) stayed green. A type checker cannot see a temporal dead
 * zone, so the invariant has to be asserted directly.
 *
 * Fix a violation by moving the shared values into a leaf module that imports
 * nothing — see `engine/dockerNames.ts` — rather than by reordering imports,
 * which only moves the hazard somewhere less visible.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** `import`/`export ... from './x.js'`, skipping type-only forms (erased at compile time). */
const IMPORT_RE = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/;
const TYPE_ONLY_RE = /^\s*(?:import|export)\s+type\s/;

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Tooling scratch directories are not part of the module graph.
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectSources(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function resolveSpecifier(from: string, spec: string, known: Set<string>): string | null {
  const base = path.resolve(path.dirname(from), spec);
  // TypeScript ESM writes '.js' specifiers that resolve to '.ts' sources.
  const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, path.join(base, 'index.ts')];
  return candidates.find((c) => known.has(c)) ?? null;
}

function buildGraph(): Map<string, string[]> {
  const sources = collectSources(SRC);
  const known = new Set(sources);
  const graph = new Map<string, string[]>();
  for (const file of sources) {
    const edges: string[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = IMPORT_RE.exec(line);
      if (!m || TYPE_ONLY_RE.test(line)) continue;
      const target = resolveSpecifier(file, m[1]!, known);
      if (target) edges.push(target);
    }
    graph.set(file, edges);
  }
  return graph;
}

/** Every cycle found, each as a readable `a.ts -> b.ts -> a.ts` chain. */
function findCycles(graph: Map<string, string[]>): string[] {
  const rel = (p: string) => path.relative(SRC, p).replace(/\\/g, '/');
  const cycles: string[] = [];
  const seen = new Set<string>();
  const finished = new Set<string>();

  const walk = (node: string, stack: string[]): void => {
    for (const next of graph.get(node) ?? []) {
      const at = stack.indexOf(next);
      if (at !== -1) {
        const chain = [...stack.slice(at), next];
        // Normalise rotations so one cycle is not reported N times.
        const key = [...chain.slice(0, -1)].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(chain.map(rel).join(' -> '));
        }
        continue;
      }
      if (finished.has(next)) continue;
      walk(next, [...stack, next]);
    }
    finished.add(node);
  };

  for (const node of graph.keys()) if (!finished.has(node)) walk(node, [node]);
  return cycles;
}

describe('module graph', () => {
  it('has no runtime import cycles', () => {
    const cycles = findCycles(buildGraph());
    expect(cycles, `import cycle(s) found:\n  ${cycles.join('\n  ')}`).toEqual([]);
  });

  it('resolves the graph it is asserting over', () => {
    // A regex that silently matched nothing would make the assertion above
    // pass for the wrong reason.
    const graph = buildGraph();
    expect(graph.size).toBeGreaterThan(50);
    expect([...graph.values()].flat().length).toBeGreaterThan(100);
  });

  it('keeps the shared Docker names in a leaf module', () => {
    const leaf = path.join(SRC, 'engine/dockerNames.ts');
    const edges = buildGraph().get(leaf);
    // The whole point of the file: nothing to be half-initialised by.
    expect(edges).toEqual([]);
  });

  it('re-exports the Docker names from proxy for existing importers', () => {
    expect(proxy.NETWORK).toBe(NETWORK);
    expect(proxy.TRAEFIK_CONTAINER).toBe(TRAEFIK_CONTAINER);
    expect(proxy.TRAEFIK_IMAGE).toBe(TRAEFIK_IMAGE);
  });

  it('evaluates serviceBridge module-scope constants against a live NETWORK', () => {
    // The exact expression that threw on every boot.
    expect(RESERVED_NETWORKS).toEqual([NETWORK]);
  });
});
