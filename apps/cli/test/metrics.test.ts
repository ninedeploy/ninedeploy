import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metricsFlush, metricsFlushAction, metricsShow, metricsShowAction } from '../src/commands/metrics.js';

const h = vi.hoisted(() => ({
  errorSpy: vi.fn(),
  infoSpy: vi.fn(),
  successSpy: vi.fn(),
  headerSpy: vi.fn(),
}));

vi.mock('../src/lib/format.js', () => ({
  error: h.errorSpy,
  header: h.headerSpy,
  info: h.infoSpy,
  success: h.successSpy,
}));

interface FakeMetricHistory {
  get: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
}

function newClient(): { metricHistory: FakeMetricHistory } {
  return {
    metricHistory: {
      get: vi.fn(),
      flush: vi.fn(),
    },
  };
}

let savedExitCode: number | undefined;
beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  h.errorSpy.mockReset();
  h.infoSpy.mockReset();
  h.successSpy.mockReset();
  h.headerSpy.mockReset();
});
afterEach(() => {
  process.exitCode = savedExitCode;
});

describe('metrics show', () => {
  it('delegates to client.metricHistory.get', async () => {
    const client = newClient();
    (client.metricHistory.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: true,
      backend: 'builtin',
      events: ['deployment.status_changed', 'service.health_changed', 'backup.completed', 'alert.triggered'],
      retentionDays: 30,
      lastFlush: { ts: 0, backend: 'builtin', count: 0 },
    });
    const result = await metricsShow(client as never);
    expect(result.backend).toBe('builtin');
    expect(client.metricHistory.get).toHaveBeenCalledOnce();
  });

  it('prints the active configuration via the formatted action', async () => {
    const client = newClient();
    (client.metricHistory.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: true,
      backend: 'prometheus',
      events: ['deployment.status_changed'],
      retentionDays: 14,
      lastFlush: { ts: 0, backend: 'builtin', count: 0 },
    });
    await metricsShowAction(client as never);
    expect(h.headerSpy).toHaveBeenCalledWith('Metric history');
    const printed = h.infoSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('Enabled:      yes');
    expect(printed).toContain('Backend:      prometheus');
    expect(printed).toContain('Retention:    14 day(s)');
    expect(printed).toContain('deployment.status_changed');
    expect(printed).toContain('Last flush:');
    expect(process.exitCode).toBe(0);
  });

  it('falls back to a readable placeholder for an empty event list', async () => {
    const client = newClient();
    (client.metricHistory.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: false,
      backend: 'influxdb',
      events: [],
      retentionDays: 7,
      lastFlush: { ts: 0, backend: 'influxdb', count: 0 },
    });
    await metricsShowAction(client as never);
    const printed = h.infoSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('Enabled:      no');
    expect(printed).toContain('Backend:      influxdb');
    expect(printed).toContain('Events:       (none)');
  });

  it('surfaces a thrown error and sets exitCode=1', async () => {
    const client = newClient();
    (client.metricHistory.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('server down'));
    await metricsShowAction(client as never);
    expect(h.errorSpy).toHaveBeenCalledWith('server down');
    expect(process.exitCode).toBe(1);
  });

  it('falls back to String() when a non-Error is rejected', async () => {
    const client = newClient();
    (client.metricHistory.get as ReturnType<typeof vi.fn>).mockRejectedValue('plain failure');
    await metricsShowAction(client as never);
    expect(h.errorSpy).toHaveBeenCalledWith('plain failure');
    expect(process.exitCode).toBe(1);
  });

  it('renders "never" when the last-flush ts is 0', async () => {
    const client = newClient();
    (client.metricHistory.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: true,
      backend: 'builtin',
      events: ['deployment.status_changed'],
      retentionDays: 30,
      lastFlush: { ts: 0, backend: 'builtin', count: 0 },
    });
    await metricsShowAction(client as never);
    const printed = h.infoSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('Last flush:   never');
  });

  it('falls back to "builtin" when last-flush backend is missing', async () => {
    const client = newClient();
    (client.metricHistory.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: true,
      backend: 'builtin',
      events: ['deployment.status_changed'],
      retentionDays: 30,
      // `backend` intentionally omitted to exercise the `?? 'builtin'` branch.
      lastFlush: { ts: 1700000000000, count: 1 } as never,
    });
    await metricsShowAction(client as never);
    const printed = h.infoSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('backend=builtin');
  });
});

describe('metrics flush', () => {
  it('delegates to client.metricHistory.flush', async () => {
    const client = newClient();
    (client.metricHistory.flush as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, backend: 'builtin', deleted: 4 });
    const result = await metricsFlush(client as never);
    expect(result.deleted).toBe(4);
    expect(client.metricHistory.flush).toHaveBeenCalledOnce();
  });

  it('prints a success message with the row count', async () => {
    const client = newClient();
    (client.metricHistory.flush as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, backend: 'builtin', deleted: 12 });
    await metricsFlushAction(client as never);
    expect(h.headerSpy).toHaveBeenCalledWith('Metric history flush');
    expect(h.successSpy).toHaveBeenCalledWith('Flushed built-in backend — 12 row(s) trimmed');
    expect(process.exitCode).toBe(0);
  });

  it('surfaces a thrown error and sets exitCode=1', async () => {
    const client = newClient();
    (client.metricHistory.flush as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));
    await metricsFlushAction(client as never);
    expect(h.errorSpy).toHaveBeenCalledWith('timeout');
    expect(process.exitCode).toBe(1);
  });

  it('falls back to String() when a non-Error is rejected', async () => {
    const client = newClient();
    (client.metricHistory.flush as ReturnType<typeof vi.fn>).mockRejectedValue('boom');
    await metricsFlushAction(client as never);
    expect(h.errorSpy).toHaveBeenCalledWith('boom');
    expect(process.exitCode).toBe(1);
  });
});
