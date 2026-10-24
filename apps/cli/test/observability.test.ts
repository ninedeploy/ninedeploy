import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceMetricsConfigureAction, resourceMetricsSettingsAction } from '../src/commands/metrics.js';
import { logDrainQueueAction, logDrainRetryAction, logDrainDiscardAction } from '../src/commands/logDrains.js';

const output = vi.hoisted(() => ({ error: vi.fn(), header: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock('../src/lib/format.js', () => output);
const status = { pendingBatches: 2, pendingEntries: 7, payloadBytes: 120, blockedBatches: 1, pausedSources: 1, oldestAt: '2026-10-22T10:00:00.000Z' };
function fakeClient() {
  return {
    stats: { observability: { get: vi.fn().mockResolvedValue({ settings: { retentionDays: 30, prometheusEnabled: true, otlpEndpoint: 'https://collector.example/v1/metrics', hasOtlpAuthorization: true, logQueueMaxMb: 16 }, exportStatus: { lastAttemptAt: null } }), update: vi.fn().mockResolvedValue({}) } },
    logDrains: { queue: vi.fn().mockResolvedValue(status), retryQueue: vi.fn().mockResolvedValue(status), discardQueue: vi.fn().mockResolvedValue({ discardedBatches: 2 }) },
  };
}
let savedExit: typeof process.exitCode;
beforeEach(() => { savedExit = process.exitCode; process.exitCode = 0; vi.clearAllMocks(); });
afterEach(() => { process.exitCode = savedExit; vi.unstubAllEnvs(); });

describe('resource monitoring CLI', () => {
  it('sends only supplied settings and reads a collector credential from the selected environment variable', async () => {
    const client = fakeClient();
    vi.stubEnv('ND_TEST_COLLECTOR_AUTH', 'Bearer private-test-token');
    await resourceMetricsConfigureAction(client as never, { retentionDays: '90', prometheus: 'on', otlpAuthorizationEnv: 'ND_TEST_COLLECTOR_AUTH' });
    expect(client.stats.observability.update).toHaveBeenCalledWith({ retentionDays: 90, prometheusEnabled: true, otlpAuthorization: 'Bearer private-test-token' });
    expect(JSON.stringify(Object.values(output).flatMap((fn) => fn.mock.calls))).not.toContain('private-test-token');
  });
  it.each([{ retentionDays: '91' }, { retentionDays: '0' }, { logQueueMb: '257' }, { prometheus: 'yes' }, { otlpEndpoint: 'ftp://collector.example' }, { otlpAuthorizationEnv: 'bad-name' }, { otlpAuthorizationEnv: 'ND_TEST_COLLECTOR_AUTH', clearOtlpAuthorization: true }])('rejects invalid settings before issuing a request: %j', async (opts) => {
    const client = fakeClient();
    await resourceMetricsConfigureAction(client as never, opts);
    expect(client.stats.observability.update).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
  it('rejects an unset credential variable and permits an explicit saved-credential removal', async () => {
    const client = fakeClient();
    vi.stubEnv('ND_TEST_COLLECTOR_AUTH', '');
    await resourceMetricsConfigureAction(client as never, { otlpAuthorizationEnv: 'ND_TEST_COLLECTOR_AUTH' });
    expect(client.stats.observability.update).not.toHaveBeenCalled();
    await resourceMetricsConfigureAction(client as never, { clearOtlpAuthorization: true });
    expect(client.stats.observability.update).toHaveBeenCalledWith({ otlpAuthorization: '' });
  });
  it('prints saved presence and retention without revealing a credential', async () => {
    await resourceMetricsSettingsAction(fakeClient() as never);
    const text = output.info.mock.calls.flat().join('\n');
    expect(text).toContain('History: 30 day(s)');
    expect(text).toContain('Collector authorization: saved');
    expect(text).toContain('/v1/stats/prometheus');
  });
  it('reports a failed save with a failing exit code', async () => {
    const client = fakeClient();
    client.stats.observability.update.mockRejectedValue(new Error('operator required'));
    await resourceMetricsConfigureAction(client as never, { retentionDays: '7' });
    expect(output.error).toHaveBeenCalledWith('operator required');
    expect(process.exitCode).toBe(1);
  });
});

describe('log queue CLI', () => {
  it('shows backlog, capacity pressure and blocked delivery', async () => {
    const client = fakeClient();
    await logDrainQueueAction(client as never, '4');
    expect(client.logDrains.queue).toHaveBeenCalledWith(4);
    expect(output.info.mock.calls.flat().join('\n')).toContain('Blocked: 1 batch(es); paused sources: 1');
  });
  it('schedules retries without claiming logs were delivered', async () => {
    const client = fakeClient();
    await logDrainRetryAction(client as never, '4');
    expect(client.logDrains.retryQueue).toHaveBeenCalledWith(4);
    expect(output.success).toHaveBeenCalledWith(expect.stringContaining('next delivery cycle'));
  });
  it('requires explicit confirmation before deleting queued logs', async () => {
    const client = fakeClient();
    await logDrainDiscardAction(client as never, '4', {});
    expect(client.logDrains.discardQueue).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    await logDrainDiscardAction(client as never, '4', { yes: true });
    expect(client.logDrains.discardQueue).toHaveBeenCalledWith(4);
    expect(output.success).toHaveBeenCalledWith('Discarded 2 queued batch(es)');
  });
  it.each(['0', '-1', '1junk', '1.5', '9007199254740993'])('rejects an invalid drain ID %s', async (id) => {
    const client = fakeClient();
    await logDrainQueueAction(client as never, id);
    await logDrainRetryAction(client as never, id);
    await logDrainDiscardAction(client as never, id, { yes: true });
    expect(Object.values(client.logDrains).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(process.exitCode).toBe(1);
  });
  it('reports a destination that no longer exists', async () => {
    const client = fakeClient();
    client.logDrains.retryQueue.mockRejectedValue(new Error('not found'));
    await logDrainRetryAction(client as never, '4');
    expect(output.error).toHaveBeenCalledWith('not found');
    expect(process.exitCode).toBe(1);
  });
});
