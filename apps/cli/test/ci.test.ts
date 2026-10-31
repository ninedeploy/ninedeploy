import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ciDecide, ciJobsList, ciLog, ciPipelineSet, ciPipelineShow, ciRun, ciRunnersAdd, ciRunnersList, ciRunnersRevoke } from '../src/commands/ci.js';

/** R5: `ninedeploy ci …`. */

vi.mock('../src/config.js', () => ({ loadConfig: () => ({ baseUrl: 'https://panel.example/' }), saveConfig: vi.fn() }));

const ESC = String.fromCharCode(27);

function makeClient() {
  return {
    services: { list: vi.fn().mockResolvedValue([{ id: 4, slug: 'web', name: 'Web' }]) },
    ci: {
      runners: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
      pipeline: vi.fn(),
      setPipeline: vi.fn(),
      deletePipeline: vi.fn(),
      jobs: { list: vi.fn(), get: vi.fn(), create: vi.fn(), approve: vi.fn(), cancel: vi.fn(), log: vi.fn() },
    },
  };
}
type Client = ReturnType<typeof makeClient>;
const asClient = (c: Client) => c as never;

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let written: string[];
const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const err = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  vi.resetAllMocks();
  written = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  process.exitCode = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const job = (over: Record<string, unknown> = {}) => ({
  id: 12, serviceId: 4, status: 'running', ref: null, commitSha: 'abcdef1234567890abcdef1234567890abcdef12', image: 'node:24-alpine',
  labels: [], secretNames: [], trigger: 'deploy', deploymentId: 40, attempts: 1, maxAttempts: 2, timeoutSeconds: 600,
  error: null, createdBy: null, approvedBy: null, createdAt: '2026-10-31T09:00:00.000Z', startedAt: null, finishedAt: null, ...over,
});
const attempt = (number: number) => ({
  id: 30 + number, number, runnerId: 2, runnerName: 'builder-1', status: 'running', exitCode: null, error: null, logBytes: 0,
  startedAt: '2026-10-31T09:00:01.000Z', finishedAt: null,
});

describe('ninedeploy ci runners', () => {
  it('lists runners with their state and load', async () => {
    const client = makeClient();
    client.ci.runners.list.mockResolvedValue([
      { id: 1, name: 'builder-1', labels: ['linux'], capacity: 2, version: 'v1', lastSeenAt: '2026-10-31T09:00:00.000Z', online: true, revokedAt: null, running: 1, createdAt: '' },
    ]);
    await ciRunnersList(asClient(client));
    expect(out()).toContain('builder-1');
    expect(out()).toContain('1/2');
    expect(out()).toContain('online');
  });

  it('adds a runner with labels and capacity and prints its token once', async () => {
    const client = makeClient();
    client.ci.runners.create.mockResolvedValue({ id: 3, name: 'b', token: 'ndrun_tok' });
    await ciRunnersAdd(asClient(client), 'b', { labels: 'linux, x64', capacity: '2' });
    expect(client.ci.runners.create).toHaveBeenCalledWith({ name: 'b', labels: ['linux', 'x64'], capacity: 2 });
    expect(out()).toContain('ndrun_tok');
  });

  it('refuses a bad capacity or id before calling the panel', async () => {
    const client = makeClient();
    await ciRunnersAdd(asClient(client), 'b', { capacity: 'two' });
    await ciRunnersRevoke(asClient(client), '-1');
    expect(client.ci.runners.create).not.toHaveBeenCalled();
    expect(client.ci.runners.revoke).not.toHaveBeenCalled();
    expect(err()).toContain('--capacity must be a positive integer');
    expect(process.exitCode).toBe(1);
  });
});

describe('ninedeploy ci pipeline / set / jobs', () => {
  it('shows a pipeline, and says when there is none', async () => {
    const client = makeClient();
    client.ci.pipeline.mockResolvedValueOnce({ pipeline: null });
    await ciPipelineShow(asClient(client), 'web');
    expect(out()).toContain('no CI pipeline');
    client.ci.pipeline.mockResolvedValueOnce({
      pipeline: { image: 'node:24-alpine', script: 'npm test', labels: [], secrets: ['NPM_TOKEN'], timeoutMinutes: 30, maxAttempts: 2, requireApproval: false, runOnPush: true, gateDeploys: true },
    });
    await ciPipelineShow(asClient(client), 'web');
    expect(client.ci.pipeline).toHaveBeenLastCalledWith(4);
    expect(out()).toContain('NPM_TOKEN');
    expect(out()).toContain('npm test');
  });

  it('sets a pipeline from a JSON file and refuses a file that is not JSON', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-cli-ci-'));
    try {
      const good = path.join(dir, 'p.json');
      writeFileSync(good, JSON.stringify({ image: 'alpine:3.20', script: 'true', gateDeploys: true }));
      const client = makeClient();
      client.ci.setPipeline.mockResolvedValue({ pipeline: {} });
      await ciPipelineSet(asClient(client), '4', good);
      expect(client.ci.setPipeline).toHaveBeenCalledWith(4, { image: 'alpine:3.20', script: 'true', gateDeploys: true });
      const bad = path.join(dir, 'bad.json');
      writeFileSync(bad, 'image: alpine');
      await ciPipelineSet(asClient(client), '4', bad);
      expect(client.ci.setPipeline).toHaveBeenCalledTimes(1);
      expect(err()).toContain('as JSON');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists jobs with the deploy they gate', async () => {
    const client = makeClient();
    client.ci.jobs.list.mockResolvedValue([job({ status: 'failed' })]);
    await ciJobsList(asClient(client), 'web');
    expect(out()).toContain('deploy #40');
    expect(out()).toContain('abcdef1');
  });
});

describe('ninedeploy ci run / log / approve / cancel', () => {
  it('runs a job and follows it to a failure, exiting non-zero', async () => {
    const client = makeClient();
    client.ci.jobs.create.mockResolvedValue(job({ status: 'queued' }));
    client.ci.jobs.get
      .mockResolvedValueOnce({ job: job(), attempts: [attempt(1)] })
      .mockResolvedValueOnce({ job: job({ status: 'failed', error: 'Exited with 1' }), attempts: [attempt(1)] });
    client.ci.jobs.log
      .mockResolvedValueOnce({ data: 'npm test\n', size: 9, done: false })
      .mockResolvedValueOnce({ data: 'boom\n', size: 14, done: true });
    await ciRun(asClient(client), 'web', { ref: 'main', follow: true, pollMs: 1 });
    expect(client.ci.jobs.create).toHaveBeenCalledWith(4, { ref: 'main' });
    expect(client.ci.jobs.log).toHaveBeenNthCalledWith(1, 4, 12, 1, { offset: 0 });
    expect(client.ci.jobs.log).toHaveBeenNthCalledWith(2, 4, 12, 1, { offset: 9 });
    // (the spinner writes to stdout too)
    expect(written.join('')).toContain('npm test\nboom\n');
    expect(err()).toContain('Job #12 failed: Exited with 1');
    expect(process.exitCode).toBe(1);
  });

  it("prints the last attempt's log with colours kept and other control sequences removed", async () => {
    const client = makeClient();
    client.ci.jobs.get.mockResolvedValue({ job: job({ status: 'succeeded' }), attempts: [attempt(1), attempt(2)] });
    client.ci.jobs.log.mockResolvedValue({ data: `${ESC}[32mok${ESC}[0m ${ESC}]52;c;ZXZpbA==${String.fromCharCode(7)}${ESC}[2Jdone\n`, size: 40, done: true });
    await ciLog(asClient(client), 'web', '12');
    expect(client.ci.jobs.log).toHaveBeenCalledWith(4, 12, 2, { offset: 0 });
    expect(written.join('')).toBe(`${ESC}[32mok${ESC}[0m done\n`);
  });

  it('approves and cancels a job', async () => {
    const client = makeClient();
    client.ci.jobs.approve.mockResolvedValue({ ok: true });
    client.ci.jobs.cancel.mockResolvedValue({ ok: true });
    await ciDecide(asClient(client), 'approve', 'web', '12');
    await ciDecide(asClient(client), 'cancel', 'Web', '12');
    expect(client.ci.jobs.approve).toHaveBeenCalledWith(4, 12);
    expect(client.ci.jobs.cancel).toHaveBeenCalledWith(4, 12);
  });
});
