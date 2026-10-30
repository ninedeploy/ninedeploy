import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export function nodeProxyDirectory(): string {
  const base = resolve(process.cwd(), '.agent-proxy');
  mkdirSync(join(base, 'dynamic'), { recursive: true, mode: 0o700 });
  return base;
}
export function nodeProxyJournalDirectory(): string { return join(process.cwd(), '.agent-proxy', '.journal'); }
export function writeNodeProxyFile(kind: 'static' | 'dynamic', content: string): { path: string; changed: boolean } {
  const base = nodeProxyDirectory();
  const target = kind === 'static' ? join(base, 'traefik.yml') : join(base, 'dynamic', 'ninedeploy.yml');
  const changed = (existsSync(target) ? readFileSync(target, 'utf8') : null) !== content;
  if (changed) {
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, target);
  }
  return { path: relative(process.cwd(), target), changed };
}
