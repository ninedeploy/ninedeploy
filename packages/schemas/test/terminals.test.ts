import { describe, expect, it } from 'vitest';
import {
  createTerminalSession,
  TERMINAL_CLOSE,
  TERMINAL_COLS_MAX,
  TERMINAL_COLS_MIN,
  TERMINAL_FRAME_MAX_BYTES,
  TERMINAL_HISTORY_LIMIT_MAX,
  TERMINAL_PROTOCOL,
  TERMINAL_ROWS_MAX,
  TERMINAL_ROWS_MIN,
  TERMINAL_SETTINGS_DEFAULTS,
  TERMINAL_TICKET_PROTOCOL_PREFIX,
  terminalClientMessage,
  terminalServerMessage,
  terminalSession,
  terminalSessionCreated,
  terminalSessionListQuery,
  terminalSessionStatus,
  terminalSettings,
  terminalSettingsView,
  terminalTarget,
  terminalTargetKind,
} from '../src/terminals.js';

describe('terminalTarget (0.15)', () => {
  it('accepts every target kind', () => {
    expect(terminalTarget.parse({ kind: 'service', serviceId: 3 })).toEqual({ kind: 'service', serviceId: 3 });
    expect(terminalTarget.parse({ kind: 'service', serviceId: 3, replica: 2, serverId: 4 })).toEqual({
      kind: 'service',
      serviceId: 3,
      replica: 2,
      serverId: 4,
    });
    expect(terminalTarget.parse({ kind: 'database', databaseId: 7 })).toEqual({ kind: 'database', databaseId: 7, mode: 'shell' });
    expect(terminalTarget.parse({ kind: 'database', databaseId: 7, mode: 'client' })).toMatchObject({ mode: 'client' });
    expect(terminalTarget.parse({ kind: 'container', name: 'nd-app-web' })).toEqual({ kind: 'container', name: 'nd-app-web' });
    expect(terminalTarget.parse({ kind: 'host', serverId: null })).toEqual({ kind: 'host', serverId: null });
    expect(terminalTarget.parse({ kind: 'host', serverId: 2 })).toEqual({ kind: 'host', serverId: 2 });
  });

  it('refuses unknown kinds, stray keys, bad replicas and container names', () => {
    expect(terminalTarget.safeParse({ kind: 'panel' }).success).toBe(false);
    expect(terminalTarget.safeParse({ kind: 'service', serviceId: 1, extra: true }).success).toBe(false);
    expect(terminalTarget.safeParse({ kind: 'service', serviceId: 1, replica: 0 }).success).toBe(false);
    expect(terminalTarget.safeParse({ kind: 'service', serviceId: 1, replica: 51 }).success).toBe(false);
    expect(terminalTarget.safeParse({ kind: 'database', databaseId: 1, mode: 'root' }).success).toBe(false);
    for (const name of ['-x', 'a', 'a b', '../etc', 'x'.repeat(129)]) {
      expect(terminalTarget.safeParse({ kind: 'container', name }).success, name).toBe(false);
    }
    // A host target must say which host: null (panel) is explicit, absence is not.
    expect(terminalTarget.safeParse({ kind: 'host' }).success).toBe(false);
  });

  it('lists the kinds and statuses the table stores', () => {
    expect(terminalTargetKind.options).toEqual(['service', 'database', 'container', 'host']);
    expect(terminalSessionStatus.options).toEqual(['pending', 'active', 'ended', 'failed', 'expired']);
  });
});

describe('createTerminalSession', () => {
  it('defaults the size to 120x32', () => {
    expect(createTerminalSession.parse({ target: { kind: 'service', serviceId: 1 } })).toEqual({
      target: { kind: 'service', serviceId: 1 },
      cols: 120,
      rows: 32,
    });
  });

  it('bounds cols and rows and keeps a step-up password', () => {
    const target = { kind: 'host', serverId: null };
    expect(createTerminalSession.parse({ target, cols: TERMINAL_COLS_MIN, rows: TERMINAL_ROWS_MAX, password: 'pw' })).toMatchObject({
      cols: 10,
      rows: 200,
      password: 'pw',
    });
    expect(createTerminalSession.safeParse({ target, cols: TERMINAL_COLS_MAX + 1 }).success).toBe(false);
    expect(createTerminalSession.safeParse({ target, rows: TERMINAL_ROWS_MIN - 1 }).success).toBe(false);
    expect(createTerminalSession.safeParse({ target, password: '' }).success).toBe(false);
    expect(createTerminalSession.safeParse({ target, password: 'x'.repeat(1025) }).success).toBe(false);
    expect(createTerminalSession.safeParse({ target, transcript: true }).success).toBe(false);
  });
});

const session = {
  id: 1,
  status: 'ended',
  targetKind: 'service',
  targetLabel: 'web (replica 1)',
  serverId: null,
  userId: 2,
  userEmail: 'op@example.com',
  createdAt: '2026-10-08T00:00:00.000Z',
  startedAt: '2026-10-08T00:00:01.000Z',
  endedAt: '2026-10-08T00:01:01.000Z',
  durationMs: 60_000,
  bytesIn: 10,
  bytesOut: 2048,
  endReason: 'shell_exited',
  exitCode: 0,
  clientIp: '203.0.113.9',
};

describe('terminal views', () => {
  it('describes a session row and the create answer', () => {
    expect(terminalSession.parse(session)).toEqual(session);
    expect(terminalSession.safeParse({ ...session, bytesOut: -1 }).success).toBe(false);
    const created = { session, ticket: 'abc', ticketExpiresAt: '2026-10-08T00:00:30.000Z', attachPath: '/v1/terminals/1/attach' };
    expect(terminalSessionCreated.parse(created)).toEqual(created);
    expect(terminalSessionCreated.safeParse({ ...created, attachPath: '/v1/terminals/x/attach' }).success).toBe(false);
  });

  it('coerces the history query and caps the limit', () => {
    expect(terminalSessionListQuery.parse({})).toEqual({ limit: 50 });
    expect(terminalSessionListQuery.parse({ status: 'active', userId: '4', targetKind: 'host', limit: '200', before: '9' })).toEqual({
      status: 'active',
      userId: 4,
      targetKind: 'host',
      limit: TERMINAL_HISTORY_LIMIT_MAX,
      before: 9,
    });
    expect(terminalSessionListQuery.safeParse({ limit: '201' }).success).toBe(false);
    expect(terminalSessionListQuery.safeParse({ sort: 'x' }).success).toBe(false);
  });
});

describe('terminalSettings', () => {
  it('is partial and strict', () => {
    expect(terminalSettings.parse({})).toEqual({});
    expect(terminalSettings.parse({ hostTerminalEnabled: true, password: 'pw' })).toEqual({ hostTerminalEnabled: true, password: 'pw' });
    expect(terminalSettings.safeParse({ hostShell: true }).success).toBe(false);
  });

  it('bounds every limit', () => {
    const ok = { idleTimeoutMinutes: 1, maxSessionMinutes: 1440, maxConcurrent: 50, retentionDays: 3650 };
    expect(terminalSettings.parse(ok)).toEqual(ok);
    for (const bad of [
      { idleTimeoutMinutes: 0 },
      { idleTimeoutMinutes: 241 },
      { maxSessionMinutes: 4 },
      { maxConcurrent: 51 },
      { retentionDays: 29 },
      { retentionDays: 3651 },
    ]) {
      expect(terminalSettings.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('ships host shells off by default (O1) and describes the stored view', () => {
    expect(TERMINAL_SETTINGS_DEFAULTS).toEqual({
      hostTerminalEnabled: false,
      idleTimeoutMinutes: 15,
      maxSessionMinutes: 240,
      maxConcurrent: 10,
      retentionDays: 180,
    });
    const view = { ...TERMINAL_SETTINGS_DEFAULTS, hostTerminalForbiddenByEnv: false };
    expect(terminalSettingsView.parse(view)).toEqual(view);
  });
});

describe('attach protocol v1', () => {
  it('parses client resize and ping frames', () => {
    expect(terminalClientMessage.parse({ t: 'resize', cols: 80, rows: 24 })).toEqual({ t: 'resize', cols: 80, rows: 24 });
    expect(terminalClientMessage.parse({ t: 'ping' })).toEqual({ t: 'ping' });
    expect(terminalClientMessage.safeParse({ t: 'resize', cols: 9, rows: 24 }).success).toBe(false);
    expect(terminalClientMessage.safeParse({ t: 'resize', cols: 80, rows: 201 }).success).toBe(false);
    expect(terminalClientMessage.safeParse({ t: 'stdin', data: 'x' }).success).toBe(false);
  });

  it('parses server ready, notice and exit frames', () => {
    const ready = { t: 'ready', sessionId: 1, target: { kind: 'host', label: 'panel host', serverId: null } };
    expect(terminalServerMessage.parse(ready)).toEqual(ready);
    expect(terminalServerMessage.parse({ t: 'notice', message: 'idle in 1 minute' })).toEqual({ t: 'notice', message: 'idle in 1 minute' });
    expect(terminalServerMessage.parse({ t: 'exit', code: null, reason: 'idle' })).toEqual({ t: 'exit', code: null, reason: 'idle' });
  });

  it('pins the close codes, frame cap and subprotocol names', () => {
    expect(TERMINAL_CLOSE).toEqual({
      shellExited: 1000,
      frameTooLarge: 1009,
      badTicket: 4401,
      forbidden: 4403,
      idle: 4408,
      maxDuration: 4409,
      terminated: 4410,
      tooManySessions: 4429,
      targetUnreachable: 4502,
    });
    expect(TERMINAL_FRAME_MAX_BYTES).toBe(65_536);
    expect(TERMINAL_PROTOCOL).toBe('ninedeploy.terminal.v1');
    expect(TERMINAL_TICKET_PROTOCOL_PREFIX).toBe('ninedeploy.ticket.');
  });
});
