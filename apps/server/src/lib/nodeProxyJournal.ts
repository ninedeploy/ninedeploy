import { createHash } from 'node:crypto';
import { withNodeServiceJournal } from './nodeLifecycle.js';

type ProxyWrite = { revision: number; requestId: string; timeoutMs: number; content: string };
type ProxyReceipt = { revision: number; requestId: string; contentHash: string; complete: true; changed: boolean };
const schema = 'CREATE TABLE IF NOT EXISTS proxy_write_head (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, request_id TEXT NOT NULL, content_hash TEXT NOT NULL, receipt TEXT)';
const digest = (content: string) => createHash('sha256').update(content).digest('hex');

/** Reserve a durable node-wide revision before writing a dynamic proxy file. */
export async function orderedNodeProxyWrite(root: string, input: ProxyWrite, write: (content: string) => Promise<boolean>): Promise<ProxyReceipt> {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || !/^[a-f0-9]{32}$/.test(input.requestId) ||
    !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000 || typeof input.content !== 'string' ||
    input.content.includes('\0') || Buffer.byteLength(input.content) > 1_048_576) throw new Error('Invalid ordered proxy write');
  const contentHash = digest(input.content);
  return withNodeServiceJournal(root, 1, input.timeoutMs, async journal => {
    await journal.write(async () => {
      journal.database.exec(schema);
      const head = journal.database.prepare('SELECT revision,request_id,content_hash FROM proxy_write_head WHERE id=1').get();
      if (head && (!Number.isSafeInteger(head.revision) || Number(head.revision) < 1 || typeof head.request_id !== 'string' ||
        !/^[a-f0-9]{32}$/.test(head.request_id) || typeof head.content_hash !== 'string' || !/^[a-f0-9]{64}$/.test(head.content_hash))) throw new Error('Proxy journal is unconfirmed');
      if (head && Number(head.revision) > input.revision) throw new Error('Proxy write is stale');
      if (head && Number(head.revision) === input.revision && (head.request_id !== input.requestId || head.content_hash !== contentHash)) throw new Error('Proxy revision conflicts with a different write');
      if (!head || Number(head.revision) < input.revision) journal.database.prepare(
        'INSERT INTO proxy_write_head(id,revision,request_id,content_hash,receipt) VALUES(1,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,request_id=excluded.request_id,content_hash=excluded.content_hash,receipt=NULL',
      ).run(input.revision, input.requestId, contentHash);
    });
    return journal.write(async () => {
      const head = journal.database.prepare('SELECT revision,request_id,content_hash,receipt FROM proxy_write_head WHERE id=1').get();
      if (!head || head.revision !== input.revision || head.request_id !== input.requestId || head.content_hash !== contentHash) throw new Error('Proxy write is stale');
      if (head.receipt !== null) {
        const receipt: unknown = JSON.parse(String(head.receipt));
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Proxy receipt is unconfirmed');
        const r = receipt as Record<string, unknown>;
        if (r.revision !== input.revision || r.requestId !== input.requestId || r.contentHash !== contentHash || r.complete !== true || typeof r.changed !== 'boolean') throw new Error('Proxy receipt is unconfirmed');
        return r as ProxyReceipt;
      }
      const changed = await write(input.content);
      if (typeof changed !== 'boolean') throw new Error('Proxy write result is unconfirmed');
      const receipt: ProxyReceipt = { revision: input.revision, requestId: input.requestId, contentHash, complete: true, changed };
      journal.database.prepare('UPDATE proxy_write_head SET receipt=? WHERE id=1').run(JSON.stringify(receipt));
      return receipt;
    });
  });
}

/** Drain legacy writes before adopting the ordered protocol, then reject them. */
export async function legacyNodeProxyWrite<T>(root: string, timeoutMs: number, write: () => Promise<T>): Promise<T> {
  return withNodeServiceJournal(root, 1, timeoutMs, journal => journal.write(async () => {
    journal.database.exec(schema);
    if (journal.database.prepare('SELECT revision FROM proxy_write_head WHERE id=1').get()) throw new Error('Unversioned proxy write is fenced by ordered routing');
    return write();
  }));
}
