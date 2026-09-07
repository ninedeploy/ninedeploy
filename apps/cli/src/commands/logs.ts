/**
 * `ninedeploy logs search` — G-16 cluster log search via
 * the configured Loki drain. The CLI is a thin renderer
 * around `client.logDrains.search(...)`: the heavy
 * lifting is the upstream Loki query.
 */
import type { NineDeployClient } from '../client.js';
import { c, error, header, info, spinner } from '../lib/format.js';

const num = (v: string, usage: string): number => {
  const n = Number(v);
  if (Number.isNaN(n)) {
    error(usage);
    throw new Error(usage);
  }
  return n;
};

export async function logsSearch(
  client: NineDeployClient,
  query: string,
  opts: { service?: string; since?: string; limit?: string; drain?: string; json?: boolean } = {},
): Promise<void> {
  if (!query) {
    error('Usage: ninedeploy logs search <query> [--service <id>] [--since 15m] [--drain <id>]');
    return;
  }
  const sinceMinutes = parseSinceMinutes(opts.since ?? '15m');
  const limit = opts.limit ? num(opts.limit, 'Usage: --limit <N>') : undefined;
  const drainId = opts.drain ? num(opts.drain, 'Usage: --drain <id>') : undefined;
  const serviceId = opts.service ? num(opts.service, 'Usage: --service <id>') : undefined;
  const result = await spinner('Searching logs', () =>
    client.logDrains.search({ query, serviceId, sinceMinutes, limit, drainId }),
  );
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  header('Log search');
  info(`Drain:      ${result.drain.name} (${result.drain.type})`);
  info(`Window:     ${result.window.since} → ${result.window.until}`);
  if (result.serviceId != null) info(`Service ID: ${result.serviceId}`);
  info(`Matches:    ${result.lines.length}`);
  if (result.lines.length === 0) {
    info('(no matches in the window)');
    return;
  }
  console.log();
  for (const line of result.lines) {
    const ts = new Date(line.ts).toISOString();
    const svc = line.service ? c.dim(`[${line.service}]`) : '';
    console.log(`${c.dim(ts)} ${svc} ${line.line}`);
  }
}

/** Parse `15m` / `2h` / `30s` / `1d` into minutes. The
 *  search route caps at 7d, so anything larger is clamped. */
function parseSinceMinutes(input: string): number {
  const m = /^(\d+)([smhd])$/.exec(input.trim());
  if (!m) {
    error(`Invalid --since value "${input}" (expected e.g. 15m, 2h, 1d)`);
    throw new Error(`Invalid --since value: ${input}`);
  }
  const n = Number(m[1]);
  switch (m[2]) {
    case 's': return Math.max(1, Math.ceil(n / 60));
    case 'm': return n;
    case 'h': return Math.min(7 * 24 * 60, n * 60);
    case 'd': return Math.min(7 * 24 * 60, n * 24 * 60);
    default: return 15;
  }
}
