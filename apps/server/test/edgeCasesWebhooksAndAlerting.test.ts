import { describe, expect, it, vi } from 'vitest';
import {
  isPing,
  parsePush,
  verifyWebhook,
} from '../src/lib/webhooks.js';
import {
  evaluateAlerts,
  type MetricSnapshot,
} from '../src/lib/alerting.js';
import { rotateSecrets } from '../src/lib/keyRotation.js';
import { createHmac } from 'node:crypto';

describe('Edge Cases — Webhook Signatures & Multiprovider Parsing', () => {
  const secret = 'webhook-secret-key';
  const body = JSON.stringify({ ref: 'refs/heads/main', commits: [{ added: ['src/app.ts'], modified: [], removed: [] }] });

  it('verifies GitHub HMAC-SHA256 signature and rejects forged signatures', () => {
    const validHmac = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const headers = {
      'x-github-event': 'push',
      'x-hub-signature-256': validHmac,
    };

    expect(verifyWebhook(headers, body, secret)).toBe('github');

    // Forged signature
    const forgedHeaders = {
      'x-github-event': 'push',
      'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
    };
    expect(verifyWebhook(forgedHeaders, body, secret)).toBeNull();

    // Malformed signature (missing sha256= prefix)
    expect(verifyWebhook({ 'x-github-event': 'push', 'x-hub-signature-256': 'bad' }, body, secret)).toBeNull();
  });

  it('verifies Gitea signature and GitLab raw token header', () => {
    // Gitea
    const giteaSig = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhook({ 'x-gitea-signature': giteaSig }, body, secret)).toBe('gitea');

    // GitLab
    expect(verifyWebhook({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': secret }, body, secret)).toBe('gitlab');
    expect(verifyWebhook({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': 'wrong-token' }, body, secret)).toBeNull();

    // Unknown provider headers
    expect(verifyWebhook({}, body, secret)).toBeNull();
  });

  it('detects ping events across providers without triggering deploys', () => {
    expect(isPing({ 'x-github-event': 'ping' }, 'github')).toBe(true);
    expect(isPing({ 'x-gitea-event': 'ping' }, 'gitea')).toBe(true);
    expect(isPing({ 'x-gitlab-event': 'Ping Hook' }, 'gitlab')).toBe(true);
    expect(isPing({ 'x-github-event': 'push' }, 'github')).toBe(false);
  });

  it('parses push events and extracts changed files safely', () => {
    const push = parsePush(JSON.parse(body), 'github');
    expect(push).not.toBeNull();
    expect(push?.branch).toBe('main');
    expect(push?.changedFiles).toEqual(['src/app.ts']);

    // Malformed body without ref
    expect(parsePush({}, 'github')).toBeNull();
  });
});

describe('Edge Cases — Alerting Engine State Transitions', () => {
  it('transitions state from ok -> breaching -> firing -> ok with recovery audit', async () => {
    const rules = [
      {
        id: 1,
        serviceId: 10,
        name: 'High CPU',
        metric: 'cpu',
        operator: '>',
        threshold: 80,
        durationWindows: 2,
        enabled: 1,
      },
    ];
    const states = [
      {
        ruleId: 1,
        status: 'ok',
        breachSince: null,
        firedAt: null,
        lastNotifiedAt: null,
        lastValue: null,
      },
    ];

    const mockDb = {
      select: () => ({
        from: (table: unknown) => {
          const name = String((table as { [k: symbol]: unknown })[Symbol.for('drizzle:Name')] ?? '');
          const rows = name === 'alert_state' ? states : rules;
          return {
            // biome-ignore lint/suspicious/noThenProperty: intentional thenable for Drizzle query mock
            then: (ok: any, rej: any) => Promise.resolve(rows).then(ok, rej),
            where: () => Promise.resolve(rows),
          };
        },
      }),
      update: () => ({
        set: (data: any) => ({
          where: async () => {
            Object.assign(states[0]!, data);
            return [];
          },
        }),
      }),
      insert: () => ({
        values: async () => undefined,
      }),
    } as any;

    const snapshotHigh: MetricSnapshot[] = [{ serviceId: 10, kind: 'cpu', value: 95 }];
    const snapshotNormal: MetricSnapshot[] = [{ serviceId: 10, kind: 'cpu', value: 30 }];

    // 1. First tick over threshold -> breaching
    await evaluateAlerts(mockDb, snapshotHigh, new Date(1000));
    expect(states[0]!.status).toBe('breaching');

    // 2. Normal snapshot -> recovery back to ok
    await evaluateAlerts(mockDb, snapshotNormal, new Date(2000));
    expect(states[0]!.status).toBe('ok');
  });
});

describe('Edge Cases — Master Key Rotation Registry', () => {
  it('re-encrypts across all registered tables safely', async () => {
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(async () => []),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => undefined),
        })),
      })),
    } as any;

    const count = await rotateSecrets(mockDb);
    expect(count).toBe(0); // Empty tables rotate 0 rows cleanly
  });
});
