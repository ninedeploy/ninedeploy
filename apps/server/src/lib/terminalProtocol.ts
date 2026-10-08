import {
  TERMINAL_FRAME_MAX_BYTES,
  TERMINAL_PROTOCOL,
  TERMINAL_TICKET_PROTOCOL_PREFIX,
  type TerminalServerMessage,
  terminalClientMessage,
} from '@ninedeploy/schemas';

/**
 * Browser ↔ panel terminal protocol v1 (`ninedeploy.terminal.v1`, DESIGN §1.4).
 *
 * - The client offers `['ninedeploy.terminal.v1', 'ninedeploy.ticket.<ticket>']`;
 *   the server selects the protocol name (D6's `handleProtocols`), so the
 *   ticket is never echoed.
 * - Client → server: binary frames are stdin; text frames are JSON control
 *   messages (`resize`, `ping`).
 * - Server → client: binary frames are output; text frames are JSON
 *   (`ready`, `notice`, `exit`).
 * - Frames above 64 KiB close the socket with 1009.
 *
 * Pure functions only: the socket handling lives in `terminalSessions.ts`.
 */

export type ClientFrame =
  | { kind: 'stdin'; data: Buffer }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'ping' }
  | { kind: 'too_large' }
  | { kind: 'invalid'; reason: string };

/** Normalise whatever `ws` hands a message listener into one Buffer. */
export function frameBytes(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => frameBytes(d)));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data), 'utf8');
}

/** Decode one client frame. Text frames that are not a valid control message are refused, never written to the shell. */
export function parseClientFrame(data: unknown, isBinary: boolean, maxBytes = TERMINAL_FRAME_MAX_BYTES): ClientFrame {
  const bytes = frameBytes(data);
  if (bytes.length > maxBytes) return { kind: 'too_large' };
  if (isBinary) return { kind: 'stdin', data: bytes };
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { kind: 'invalid', reason: 'text frames must be JSON control messages' };
  }
  const parsed = terminalClientMessage.safeParse(json);
  if (!parsed.success) return { kind: 'invalid', reason: 'unknown or malformed control message' };
  return parsed.data.t === 'resize' ? { kind: 'resize', cols: parsed.data.cols, rows: parsed.data.rows } : { kind: 'ping' };
}

/** A server → client text frame. */
export const encodeServerMessage = (msg: TerminalServerMessage): string => JSON.stringify(msg);

/** The offered subprotocols (`Sec-WebSocket-Protocol`, comma separated). */
export function offeredProtocols(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The attach handshake: the v1 protocol must be offered, and the ticket rides in its own subprotocol. */
export function attachHandshake(header: string | string[] | undefined): { protocol: boolean; ticket: string | null } {
  const offered = offeredProtocols(header);
  const ticketEntry = offered.find((p) => p.startsWith(TERMINAL_TICKET_PROTOCOL_PREFIX));
  const ticket = ticketEntry ? ticketEntry.slice(TERMINAL_TICKET_PROTOCOL_PREFIX.length) : '';
  return {
    protocol: offered.includes(TERMINAL_PROTOCOL),
    ticket: /^[A-Za-z0-9_-]{16,128}$/.test(ticket) ? ticket : null,
  };
}

/**
 * The `Origin` rule: a browser always sends one and it must be a panel
 * origin; a missing `Origin` (CLI, SDK in Node) is allowed, because the
 * single-use ticket — not an ambient cookie — is the credential.
 */
export function originAllowed(origin: string | string[] | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return true;
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (value === undefined || value === '') return true;
  const normalise = (o: string) => o.trim().replace(/\/+$/, '').toLowerCase();
  const wanted = normalise(value);
  return allowed.some((a) => normalise(a) === wanted);
}
