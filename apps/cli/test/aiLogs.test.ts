import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logsAnalyze, tailOption } from '../src/commands/aiLogs.js';

/** 0.16.15: `logs analyze <service> [--tail] [--json]`. */

vi.mock('../src/config.js', () => ({ loadConfig: () => ({ baseUrl: 'https://panel.example/' }), saveConfig: vi.fn() }));

const ESC = String.fromCharCode(27);

function makeClient() {
  return { services: { list: vi.fn() }, ai: { analyzeLogs: vi.fn() } };
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

describe('tailOption', () => {
  it('takes whole numbers from 20 to 5000, and nothing for none', () => {
    expect(tailOption(undefined)).toBeUndefined();
    expect(tailOption('20')).toBe(20);
    expect(tailOption('5000')).toBe(5000);
    for (const bad of ['19', '5001', '7.5', 'many']) expect(tailOption(bad)).toBeNull();
    expect(err()).toContain('--tail must be a whole number from 20 to 5000 (got "many")');
  });
});

describe('logs analyze', () => {
  it('prints the analysis line by line, with control sequences removed', async () => {
    const client = makeClient();
    client.ai.analyzeLogs.mockResolvedValue({
      analysis: `Health: degraded.\nProblems: ${ESC}[2Jdb timeout\nNext steps: 1. check the db`,
      model: 'claude-sonnet-5-5',
      lines: 42,
    });
    await logsAnalyze(asClient(client), '4', { tail: '500' });
    expect(client.ai.analyzeLogs).toHaveBeenCalledWith(4, { tail: 500 });
    expect(out()).toContain('  Health: degraded.');
    expect(out()).toContain('  Problems: db timeout');
    expect(out()).toContain('  Next steps: 1. check the db');
    expect(out()).not.toContain(`${ESC}[2J`);
    expect(out()).toContain('42 lines read by claude-sonnet-5-5');
  });

  it('prints JSON, and sends no tail when none is given', async () => {
    const client = makeClient();
    client.ai.analyzeLogs.mockResolvedValue({ analysis: 'ok', model: 'm', lines: 1 });
    await logsAnalyze(asClient(client), '4', { json: true });
    expect(client.ai.analyzeLogs).toHaveBeenCalledWith(4, undefined);
    expect(JSON.parse(out())).toEqual({ analysis: 'ok', model: 'm', lines: 1 });
  });

  it('refuses a bad tail before calling, and reports an unknown service or a refusal', async () => {
    const client = makeClient();
    await logsAnalyze(asClient(client), '4', { tail: '1' });
    expect(client.ai.analyzeLogs).not.toHaveBeenCalled();
    client.services.list.mockResolvedValue([]);
    await logsAnalyze(asClient(client), 'nope');
    expect(err()).toContain('No service named "nope".');
    client.ai.analyzeLogs.mockRejectedValue(new Error('AI analysis is not configured — ask the operator to set it up in Settings'));
    await logsAnalyze(asClient(client), '4');
    expect(err()).toContain('AI analysis is not configured');
  });
});
