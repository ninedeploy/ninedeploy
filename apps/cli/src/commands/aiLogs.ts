import type { NineDeployClient } from '../client.js';
import { c, error, header, info, spinner } from '../lib/format.js';
import { plain } from './sources.js';
import { resolveServiceRef } from './uptime.js';

/**
 * 0.16.15: `ninedeploy logs analyze <service> [--tail <n>] [--json]` — the
 * configured AI provider reads the service's newest runtime log lines
 * (sanitized on the panel before they leave it) and answers with its
 * health, the problems it sees and what to do. `<service>` is an id, a slug
 * or a name.
 */

const message = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));

/** `--tail`: whole lines from 20 to 5000; null after printing why not. */
export function tailOption(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 20 || n > 5000) {
    error(`--tail must be a whole number from 20 to 5000 (got "${plain(raw)}")`);
    return null;
  }
  return n;
}

export async function logsAnalyze(
  client: NineDeployClient,
  ref: string,
  opts: { tail?: string; json?: boolean } = {},
): Promise<void> {
  const tail = tailOption(opts.tail);
  if (tail === null) return;
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const call = () => client.ai.analyzeLogs(id, tail === undefined ? undefined : { tail });
    const res = opts.json ? await call() : await spinner('Analyzing the runtime logs', call);
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    header('AI log analysis');
    info(`${res.lines} lines read by ${plain(res.model)}`);
    console.log();
    // The answer quotes log lines, which are any program's output: no control
    // sequences reach the terminal (plain() also drops newlines, so split first).
    for (const line of res.analysis.split('\n')) console.log(`  ${plain(line)}`);
    console.log();
    console.log(c.gray('  Analyses can be wrong; check the quoted lines before acting on them.'));
  } catch (err) {
    error(message(err));
  }
}
