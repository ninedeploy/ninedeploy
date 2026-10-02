import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Drift guard: `@ninedeploy/plugin-sdk` re-declares the panel's plugin-facing
 * types by hand (it cannot import the server), and the two have drifted
 * before — `database:tabs` existed in the kernel's MenuSlot long before the
 * SDK let an author target it. Types are erased at runtime and tests are not
 * typechecked, so this compares the DECLARATIONS as source text.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

const serverTypes = read('apps', 'server', 'src', 'kernel', 'types.ts');
const sdkTypes = read('packages', 'plugin-sdk', 'src', 'types.ts');
const bootstraps = {
  process: read('apps', 'server', 'src', 'kernel', 'sandbox', 'processBootstrap.ts'),
  worker: read('apps', 'server', 'src', 'kernel', 'sandbox', 'workerBootstrap.ts'),
};

/** Members of a `type X = | 'a' | 'b';` string-literal union. */
function unionMembers(src: string, name: string): string[] {
  const m = new RegExp(`export type ${name} =([^;]+);`).exec(src);
  if (!m) throw new Error(`type ${name} not found`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
}

/**
 * Top-level member names of the `{ … }` block that starts at `start` — the
 * text at nesting depth 1 only, so parameters of a multi-line method
 * signature or fields of a nested object type are not mistaken for members.
 */
function blockMembers(src: string, start: number): string[] {
  const open = src.indexOf('{', start);
  let depth = 0;
  let flat = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) flat += c;
  }
  const names = new Set<string>();
  for (const line of flat.split('\n')) {
    const t = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/\/\*\*.*$/, '');
    const m = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)\??\s*(?:[:,]|$)/.exec(t);
    if (m && t.trim()) names.add(m[1]!);
  }
  return [...names].sort();
}

function interfaceMembers(src: string, name: string): string[] {
  const at = src.search(new RegExp(`export interface ${name}(<[^>]*>)?\\s*\\{`));
  if (at < 0) throw new Error(`interface ${name} not found`);
  return blockMembers(src, at);
}

describe('plugin-sdk ⇄ kernel type sync', () => {
  it('MenuSlot lists the same slots', () => {
    expect(unionMembers(sdkTypes, 'MenuSlot')).toEqual(unionMembers(serverTypes, 'MenuSlot'));
  });

  it('MenuItemDefinition has the same fields', () => {
    expect(interfaceMembers(sdkTypes, 'MenuItemDefinition')).toEqual(interfaceMembers(serverTypes, 'MenuItemDefinition'));
  });

  it('ConfigSchemaDefinition is the kernel ConfigDefinition minus the host-assigned pluginId', () => {
    const kernel = interfaceMembers(serverTypes, 'ConfigDefinition').filter((k) => k !== 'pluginId');
    expect(interfaceMembers(sdkTypes, 'ConfigSchemaDefinition')).toEqual(kernel);
  });

  it('every PluginContext member exists on the ctx BOTH sandbox bootstraps hand the plugin', () => {
    const sdkCtx = interfaceMembers(sdkTypes, 'PluginContext');
    const ctxOf = (src: string) => blockMembers(src, src.indexOf('const ctx = {'));
    expect(ctxOf(bootstraps.process)).toEqual(ctxOf(bootstraps.worker));
    for (const member of sdkCtx) expect(ctxOf(bootstraps.process), member).toContain(member);
  });

  it('the parser itself sees real members (guards against a vacuous pass)', () => {
    expect(unionMembers(serverTypes, 'MenuSlot')).toContain('database:tabs');
    expect(interfaceMembers(sdkTypes, 'PluginContext')).toEqual(['config', 'emit', 'logger', 'on', 'pluginId', 'tapHook']);
    expect(interfaceMembers(serverTypes, 'MenuItemDefinition')).toContain('badge');
  });
});
