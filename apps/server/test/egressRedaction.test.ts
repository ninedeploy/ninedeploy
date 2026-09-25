import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * r310 regression: an EgressBlockedError must never carry the URL's path,
 * query or userinfo. Webhook secrets live exactly there (Slack/Discord path,
 * Gotify `?token=`, Namecheap `ApiKey=`, `https://user:token@host`), and the
 * message is stored in plaintext `notification_log.error`.
 *
 * DNS is mocked so the "could not be resolved" and "resolves to a private
 * address" branches are deterministic.
 */

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: lookupMock, default: { lookup: lookupMock } }));

const fetchMock = vi.hoisted(() => vi.fn(async () => new Response('{}', { status: 200 })));
vi.stubGlobal('fetch', fetchMock);

const { assertPublicHttpUrl } = await import('../src/lib/egressGuard.js');
const { assertCloneTargetAllowed } = await import('../src/lib/gitEgress.js');
const { notifyEvent } = await import('../src/lib/notifier.js');
const { encrypt } = await import('../src/lib/crypto.js');

const SECRET = 'S3CRETtok3n';

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a rejection');
}

beforeEach(() => {
  lookupMock.mockReset();
  fetchMock.mockClear();
  delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
});

describe('r310: egress refusals name the origin only', () => {
  it('DNS failure on a Gotify ?token= URL does not echo the token', async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    const msg = await messageOf(assertPublicHttpUrl(`https://push.example.com:8443/message?token=${SECRET}`));
    expect(msg).toMatch(/could not be resolved/);
    expect(msg).toContain('https://push.example.com:8443');
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain('/message');
  });

  it('a private answer for a Slack webhook path does not echo the path', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.7', family: 4 }]);
    const msg = await messageOf(assertPublicHttpUrl(`https://hooks.example.com/services/T0/B0/${SECRET}`));
    expect(msg).toMatch(/private address 10\.0\.0\.7/);
    expect(msg).not.toContain(SECRET);
  });

  it('userinfo, query and path are all dropped for IP literals and bad schemes', async () => {
    const literal = await messageOf(assertPublicHttpUrl(`http://admin:${SECRET}@127.0.0.1:9000/x?ApiKey=${SECRET}`));
    expect(literal).toContain('http://127.0.0.1:9000');
    expect(literal).not.toContain(SECRET);
    const scheme = await messageOf(assertPublicHttpUrl(`ftp://u:${SECRET}@203.0.113.1/f`));
    expect(scheme).not.toContain(SECRET);
    const invalid = await messageOf(assertPublicHttpUrl(`not a url ${SECRET}`));
    expect(invalid).toMatch(/not a valid URL/);
    expect(invalid).not.toContain(SECRET);
  });

  it('a git remote with an embedded token does not leak it', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    const msg = await messageOf(assertCloneTargetAllowed(`https://oauth2:${SECRET}@git.example.com/org/repo.git`));
    expect(msg).toContain('https://git.example.com');
    expect(msg).not.toContain(SECRET);
  });

  it('the notification_log.error row for a Discord channel carries no secret', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    const logged: Record<string, unknown>[] = [];
    const db = {
      query: {
        notificationChannels: {
          findMany: async () => [
            {
              id: 9,
              type: 'discord',
              targetEncrypted: encrypt(`https://discord.example.com/api/webhooks/123/${SECRET}`),
              eventFilter: 'deploy',
              active: true,
            },
          ],
        },
      },
      insert: () => ({ values: async (v: Record<string, unknown>) => { logged.push(v); } }),
    } as never;
    await notifyEvent(db, { id: 1, action: 'deploy.completed', entity: 'web', ts: '2026-01-01T00:00:00.000Z' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged[0]).toMatchObject({ status: 'failed' });
    expect(String(logged[0]!['error'])).toMatch(/Refusing to send an outbound request to https:\/\/discord\.example\.com/);
    expect(String(logged[0]!['error'])).not.toContain(SECRET);
  });
});
