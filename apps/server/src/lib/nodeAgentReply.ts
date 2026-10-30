import { z } from 'zod';
import type { DB } from '@ninedeploy/db';
import { agentOp } from './agentClient.js';
import { HttpError } from './errors.js';

/**
 * One agent op whose reply is a single `<PREFIX>{json}` line: the value on
 * exit 0, the agent's own refusal (`{error:{status,code,message}}`) on a
 * non-zero exit, and `502 <unconfirmed.code>` for anything else. An agent
 * that cannot be reached is `502 node_unreachable`.
 */

const refusal = z.object({ error: z.object({ status: z.number().int().min(400).max(599), code: z.string().min(1).max(64), message: z.string().min(1).max(600) }) });

export async function agentReplyCall<T>(
  db: DB,
  serverId: number,
  op: string,
  params: Record<string, unknown>,
  opts: { prefix: string; shape: z.ZodType<T>; timeoutMs: number; unconfirmed: { code: string; message: string } },
): Promise<T> {
  const unconfirmed = () => new HttpError(502, opts.unconfirmed.code, opts.unconfirmed.message);
  let reply: Awaited<ReturnType<typeof agentOp>>;
  try {
    reply = await agentOp(db, serverId, op, params, () => undefined, { timeoutMs: opts.timeoutMs, tolerateExit: true });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'node_unreachable', `The node could not be reached: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
  }
  const line = reply.lines.find((l) => l.startsWith(opts.prefix));
  if (!line) throw unconfirmed();
  let value: unknown;
  try {
    value = JSON.parse(line.slice(opts.prefix.length));
  } catch {
    throw unconfirmed();
  }
  if (reply.exitCode !== 0) {
    const r = refusal.safeParse(value);
    if (r.success) throw new HttpError(r.data.error.status, r.data.error.code, r.data.error.message);
    throw unconfirmed();
  }
  const parsed = opts.shape.safeParse(value);
  if (!parsed.success) throw unconfirmed();
  return parsed.data;
}
