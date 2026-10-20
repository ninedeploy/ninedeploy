import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalsDecide, approvalsList, lanesList, lanesSwitch, onOff, resolveLane } from '../src/commands/approvals.js';

/** 0.16.13: `lanes list|protect|require-approval` and `approvals list|approve|reject`. */

vi.mock('../src/config.js', () => ({ loadConfig: () => ({ baseUrl: 'https://panel.example/' }), saveConfig: vi.fn() }));

const ESC = String.fromCharCode(27);

function makeClient() {
  return {
    services: { list: vi.fn() },
    environments: { list: vi.fn(), update: vi.fn() },
    deploys: { approvals: vi.fn(), approve: vi.fn(), reject: vi.fn() },
  };
}
type Client = ReturnType<typeof makeClient>;
const asClient = (c: Client) => c as never;

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const err = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const lane = (over: Record<string, unknown> = {}) => ({
  id: 2,
  workspaceId: 1,
  name: 'production',
  slug: 'production',
  serviceCount: 3,
  protected: false,
  requireApproval: false,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
  ...over,
});

const waiting = (over: Record<string, unknown> = {}) => ({
  id: 9,
  serviceId: 4,
  serviceName: `web${ESC}[2J`,
  status: 'awaiting_approval',
  commitSha: 'abcdef1234567',
  imageDigest: null,
  message: 'fix: the thing\nlong body',
  author: 'dev',
  trigger: 'webhook',
  createdAt: '2026-10-20T10:00:00.000Z',
  mayReview: true,
  ...over,
});

describe('onOff', () => {
  it('reads on and off, any case, and refuses the rest', () => {
    expect(onOff(' ON ')).toBe(true);
    expect(onOff('off')).toBe(false);
    expect(onOff('yes')).toBeNull();
    expect(err()).toContain('Expected on or off (got "yes")');
    expect(process.exitCode).toBe(1);
  });
});

describe('resolveLane', () => {
  it('finds a lane by id, slug or name', async () => {
    const client = makeClient();
    client.environments.list.mockResolvedValue([lane(), lane({ id: 3, name: 'Staging', slug: 'staging' })]);
    expect((await resolveLane(asClient(client), '3'))?.id).toBe(3);
    expect((await resolveLane(asClient(client), 'staging'))?.id).toBe(3);
    expect((await resolveLane(asClient(client), 'production'))?.id).toBe(2);
  });

  it('falls back to the name when a number is no id, and refuses unknown or ambiguous names', async () => {
    const client = makeClient();
    client.environments.list.mockResolvedValue([lane({ id: 5, name: '2024', slug: '2024' })]);
    expect((await resolveLane(asClient(client), '2024'))?.id).toBe(5);
    client.environments.list.mockResolvedValue([lane(), lane({ id: 7, workspaceId: 2 })]);
    expect(await resolveLane(asClient(client), 'production')).toBeNull();
    expect(err()).toContain('Several lanes are named "production" (ids 2, 7). Use the id.');
    expect(await resolveLane(asClient(client), 'nope')).toBeNull();
    expect(err()).toContain('No lane named "nope".');
  });
});

describe('lanes', () => {
  it('lists lanes with their switches', async () => {
    const client = makeClient();
    client.environments.list.mockResolvedValue([lane({ protected: true }), lane({ id: 3, name: 'dev', requireApproval: undefined })]);
    await lanesList(asClient(client));
    expect(out()).toContain('Deployment lanes');
    expect(out()).toContain('production');
    expect(out()).toContain('protected');
  });

  it('prints JSON with --json', async () => {
    const client = makeClient();
    client.environments.list.mockResolvedValue([lane()]);
    await lanesList(asClient(client), { json: true });
    expect(JSON.parse(out())[0].id).toBe(2);
  });

  it('reports a failed list', async () => {
    const client = makeClient();
    client.environments.list.mockRejectedValue(new Error('boom'));
    await lanesList(asClient(client));
    expect(err()).toContain('boom');
  });

  it('switches protection and approval on and off', async () => {
    const client = makeClient();
    client.environments.list.mockResolvedValue([lane()]);
    client.environments.update.mockImplementation(async (_id: number, input: Record<string, boolean>) => lane(input));
    await lanesSwitch(asClient(client), 'protected', 'production', 'on');
    expect(client.environments.update).toHaveBeenLastCalledWith(2, { protected: true });
    expect(out()).toContain('is protected: its variable values, logs and shells are for workspace admins only');
    await lanesSwitch(asClient(client), 'protected', 'production', 'off');
    expect(out()).toContain('is no longer protected');
    await lanesSwitch(asClient(client), 'requireApproval', '2', 'on');
    expect(client.environments.update).toHaveBeenLastCalledWith(2, { requireApproval: true });
    expect(out()).toContain('now wait for a workspace admin');
    await lanesSwitch(asClient(client), 'requireApproval', '2', 'off');
    expect(out()).toContain('Deploys already waiting still need a decision');
  });

  it('refuses a bad value before calling, and stops on an unknown lane or a refusal', async () => {
    const client = makeClient();
    await lanesSwitch(asClient(client), 'protected', 'production', 'maybe');
    expect(client.environments.list).not.toHaveBeenCalled();
    client.environments.list.mockResolvedValue([]);
    await lanesSwitch(asClient(client), 'protected', 'production', 'on');
    expect(client.environments.update).not.toHaveBeenCalled();
    client.environments.list.mockResolvedValue([lane()]);
    client.environments.update.mockRejectedValue(new Error('Insufficient role for this workspace'));
    await lanesSwitch(asClient(client), 'protected', 'production', 'on');
    expect(err()).toContain('Insufficient role');
  });
});

describe('approvals', () => {
  it('lists waiting deploys, terminal-safe', async () => {
    const client = makeClient();
    client.deploys.approvals.mockResolvedValue({
      items: [waiting(), waiting({ id: 10, commitSha: null, imageDigest: 'sha256:0123456789abcdef', message: null, mayReview: false }), waiting({ id: 11, commitSha: null })],
      count: 3,
    });
    await approvalsList(asClient(client));
    expect(out()).toContain('Waiting for approval');
    expect(out()).toContain('abcdef1');
    expect(out()).toContain('0123456789ab');
    expect(out()).toContain('fix: the thing');
    expect(out()).not.toContain('long body');
    expect(out()).toContain('may approve');
    expect(out()).toContain('admins only');
    expect(out()).not.toContain(`${ESC}[2J`);
  });

  it('says when nothing waits, prints JSON, and reports a failure', async () => {
    const client = makeClient();
    client.deploys.approvals.mockResolvedValue({ items: [], count: 0 });
    await approvalsList(asClient(client));
    expect(out()).toContain('No deploy is waiting for approval.');
    logSpy.mockClear();
    await approvalsList(asClient(client), { json: true });
    expect(JSON.parse(out()).count).toBe(0);
    client.deploys.approvals.mockRejectedValue(new Error('down'));
    await approvalsList(asClient(client));
    expect(err()).toContain('down');
  });

  it("approves and rejects the service's oldest waiting deploy", async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([{ id: 4, slug: 'web', name: 'web' }]);
    client.deploys.approvals.mockResolvedValue({ items: [waiting({ serviceId: 8, id: 3 }), waiting(), waiting({ id: 12 })], count: 3 });
    client.deploys.approve.mockResolvedValue({ ok: true, status: 'queued' });
    client.deploys.reject.mockResolvedValue({ ok: true, status: 'cancelled' });
    await approvalsDecide(asClient(client), 'approve', 'web');
    expect(client.deploys.approve).toHaveBeenCalledWith(4, 9);
    expect(out()).toContain('Deployment #9 approved: it builds next.');
    await approvalsDecide(asClient(client), 'reject', '4', { deployment: '12' });
    expect(client.deploys.reject).toHaveBeenCalledWith(4, 12);
    expect(out()).toContain('Deployment #12 rejected: it will not run.');
  });

  it('refuses a bad --deployment, an unknown service, nothing waiting, and reports a refusal', async () => {
    const client = makeClient();
    await approvalsDecide(asClient(client), 'approve', 'web', { deployment: 'x' });
    expect(err()).toContain('--deployment must be a positive integer');
    client.services.list.mockResolvedValue([]);
    await approvalsDecide(asClient(client), 'approve', 'web');
    expect(err()).toContain('No service named "web".');
    client.services.list.mockResolvedValue([{ id: 4, slug: 'web', name: 'web' }]);
    client.deploys.approvals.mockResolvedValue({ items: [], count: 0 });
    await approvalsDecide(asClient(client), 'reject', 'web');
    expect(err()).toContain('No deploy of this service is waiting for approval.');
    client.deploys.approve.mockRejectedValue(new Error('Only a workspace admin may approve or reject a deploy into this lane'));
    await approvalsDecide(asClient(client), 'approve', 'web', { deployment: '9' });
    expect(err()).toContain('Only a workspace admin');
    expect(client.deploys.reject).not.toHaveBeenCalled();
  });
});
