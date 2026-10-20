import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deploysDiagnose, settingLines } from '../src/commands/aiDiagnose.js';

/** 0.16.16: `deploys diagnose <service> <deployId> [--apply] [--json]`. */

vi.mock('../src/config.js', () => ({ loadConfig: () => ({ baseUrl: 'https://panel.example/' }), saveConfig: vi.fn() }));

const ESC = String.fromCharCode(27);

function makeClient() {
  return {
    services: { list: vi.fn(), update: vi.fn() },
    deploys: { trigger: vi.fn() },
    ai: { diagnose: vi.fn() },
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

const RESULT = {
  diagnosis: `Root cause: wrong port${ESC}[2J.\n\nFix:\n1. Set the port to 8080`,
  model: 'claude-sonnet-5-5',
  parts: { rootCause: 'wrong port.', evidence: [], steps: ['Set the port to 8080'] },
  proposal: {
    settings: { port: 8080, healthPath: '/health', build: { startCmd: 'node server.js' } },
    files: [{ path: 'package.json', find: '"node": "16"', replace: '"node": "20"', why: 'Node 18+ is required' }],
  },
};

describe('settingLines', () => {
  it('names each proposed setting', () => {
    expect(settingLines({ port: 8080, healthPath: '/h', build: { startCmd: 'x' } })).toEqual(['port: 8080', 'healthPath: /h', 'build.startCmd: x']);
    expect(settingLines({})).toEqual([]);
  });
});

describe('deploys diagnose', () => {
  it('prints the diagnosis, the proposal and how to apply it, terminal-safe', async () => {
    const client = makeClient();
    client.ai.diagnose.mockResolvedValue(RESULT);
    await deploysDiagnose(asClient(client), '4', '7');
    expect(client.ai.diagnose).toHaveBeenCalledWith(4, 7);
    expect(out()).toContain('  Root cause: wrong port.');
    expect(out()).not.toContain(`${ESC}[2J`);
    expect(out()).toContain('Proposed settings change');
    expect(out()).toContain('    port: 8080');
    expect(out()).toContain('    build.startCmd: node server.js');
    expect(out()).toContain('    - "node": "16"');
    expect(out()).toContain('    + "node": "20"');
    expect(out()).toContain('Node 18+ is required');
    expect(out()).toContain('ninedeploy deploys diagnose 4 7 --apply');
    expect(client.services.update).not.toHaveBeenCalled();
  });

  it('applies the settings change and starts a deploy with --apply', async () => {
    const client = makeClient();
    client.ai.diagnose.mockResolvedValue(RESULT);
    client.services.update.mockResolvedValue({ id: 4 });
    client.deploys.trigger.mockResolvedValue({ deploymentId: 12 });
    await deploysDiagnose(asClient(client), '4', '7', { apply: true });
    expect(client.services.update).toHaveBeenCalledWith(4, RESULT.proposal.settings);
    expect(client.deploys.trigger).toHaveBeenCalledWith(4);
    expect(out()).toContain('Deployment #12 is building');
  });

  it('prints JSON, with the deploy when applied', async () => {
    const client = makeClient();
    client.ai.diagnose.mockResolvedValue(RESULT);
    await deploysDiagnose(asClient(client), '4', '7', { json: true });
    expect(JSON.parse(out()).proposal.settings.port).toBe(8080);
    logSpy.mockClear();
    client.services.update.mockResolvedValue({ id: 4 });
    client.deploys.trigger.mockResolvedValue({ deploymentId: 13 });
    await deploysDiagnose(asClient(client), '4', '7', { json: true, apply: true });
    expect(JSON.parse(out())).toMatchObject({ applied: true, deploymentId: 13 });
  });

  it('says so when there is nothing to apply, and prints a plain diagnosis without a proposal', async () => {
    const client = makeClient();
    client.ai.diagnose.mockResolvedValue({ diagnosis: 'Root cause: flaky network.', model: 'm', parts: null, proposal: null });
    await deploysDiagnose(asClient(client), '4', '7');
    expect(out()).toContain('Root cause: flaky network.');
    expect(out()).not.toContain('--apply');
    await deploysDiagnose(asClient(client), '4', '7', { apply: true });
    expect(err()).toContain('The diagnosis proposes no settings change to apply.');
    client.ai.diagnose.mockResolvedValue({ diagnosis: 'x', model: 'm', proposal: { files: RESULT.proposal.files } });
    await deploysDiagnose(asClient(client), '4', '7');
    expect(out()).toContain('File');
  });

  it('refuses a bad deployment id, an unknown service, and reports a refusal', async () => {
    const client = makeClient();
    await deploysDiagnose(asClient(client), '4', 'x');
    expect(err()).toContain('<deployId> must be a positive integer');
    client.services.list.mockResolvedValue([]);
    await deploysDiagnose(asClient(client), 'nope', '7');
    expect(err()).toContain('No service named "nope".');
    client.ai.diagnose.mockRejectedValue(new Error('Only failed deployments can be diagnosed'));
    await deploysDiagnose(asClient(client), '4', '7');
    expect(err()).toContain('Only failed deployments can be diagnosed');
  });
});
