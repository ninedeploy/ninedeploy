import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NineDeployError } from '@ninedeploy/sdk';
import { proxyConfigClear, proxyConfigGet, proxyConfigSet, proxyConfigValidate } from '../src/commands/proxyConfig.js';

/** 0.14: `ninedeploy proxy config get|validate|set|clear`. */

const h = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock('../src/prompts.js', () => ({ prompt: h.prompt, promptHidden: vi.fn() }));

const ESC = String.fromCharCode(27);

function makeClient() {
  return { traefik: { customConfig: { get: vi.fn(), validate: vi.fn(), set: vi.fn(), clear: vi.fn() } } };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const err = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

let dir: string;
let file: string;

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = 0;
  dir = mkdtempSync(path.join(tmpdir(), 'nd-proxy-'));
  file = path.join(dir, 'custom.yml');
  writeFileSync(file, 'http:\n  routers: {}\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

const issue = (message: string, p = 'http.routers.a') => ({ path: p, message });

describe('proxy config get', () => {
  it('prints the status and the YAML line by line, sanitised', async () => {
    const client = makeClient();
    client.traefik.customConfig.get.mockResolvedValue({
      content: `http:\n  routers:${ESC}[2J\n    custom-a: {}`,
      sha256: 'abc',
      updatedAt: '2026-10-08T00:00:00.000Z',
      updatedBy: 3,
      status: 'applied',
      lastError: null,
    });
    await proxyConfigGet(client as never);
    expect(out()).toContain('applied');
    expect(out()).toContain('user #3');
    expect(out()).toContain('http:\n  routers:\n    custom-a: {}');
    expect(out()).not.toContain(`${ESC}[2J`);
  });

  it('shows a rejected config, an empty one, and errors', async () => {
    const client = makeClient();
    client.traefik.customConfig.get.mockResolvedValueOnce({
      content: 'x: 1', sha256: 'a', updatedAt: null, updatedBy: null, status: 'rejected', lastError: 'router failed',
    });
    await proxyConfigGet(client as never);
    expect(out()).toContain('router failed');
    client.traefik.customConfig.get.mockResolvedValueOnce({
      content: null, sha256: null, updatedAt: null, updatedBy: null, status: 'none', lastError: null,
    });
    await proxyConfigGet(client as never);
    expect(out()).toContain('No custom config saved');
    client.traefik.customConfig.get.mockRejectedValue(new Error('Operator access required'));
    await proxyConfigGet(client as never);
    expect(err()).toContain('Operator access required');
  });
});

describe('proxy config validate / set', () => {
  it('validates a file and prints findings', async () => {
    const client = makeClient();
    client.traefik.customConfig.validate.mockResolvedValueOnce({ ok: true, errors: [], warnings: [issue('no acme email', '')] });
    await proxyConfigValidate(client as never, { file });
    expect(client.traefik.customConfig.validate).toHaveBeenCalledWith('http:\n  routers: {}\n');
    expect(out()).toContain('no acme email');
    expect(out()).toContain('The config is valid');
    client.traefik.customConfig.validate.mockResolvedValueOnce({ ok: false, errors: [issue(`bad name${ESC}[5m`)], warnings: [] });
    await proxyConfigValidate(client as never, { file });
    expect(out()).toContain('http.routers.a: bad name');
    expect(out()).not.toContain(`${ESC}[5m`);
    expect(err()).toContain('1 error(s)');
    client.traefik.customConfig.validate.mockRejectedValue(new Error('boom'));
    await proxyConfigValidate(client as never, { file });
    expect(err()).toContain('boom');
  });

  it('refuses a missing, unreadable or empty file', async () => {
    const client = makeClient();
    await proxyConfigValidate(client as never);
    expect(err()).toContain('Usage: ninedeploy proxy config validate --file <path>');
    await proxyConfigSet(client as never, { file: path.join(dir, 'missing.yml') });
    expect(err()).toContain('Cannot read');
    const empty = path.join(dir, 'empty.yml');
    writeFileSync(empty, '  \n');
    await proxyConfigSet(client as never, { file: empty });
    expect(err()).toContain('is empty');
    expect(client.traefik.customConfig.set).not.toHaveBeenCalled();
  });

  it('applies a file and prints warnings', async () => {
    const client = makeClient();
    client.traefik.customConfig.set.mockResolvedValue({ ok: true, status: 'applied', sha256: '0123456789abcdef', warnings: [issue('shadows a panel router')] });
    await proxyConfigSet(client as never, { file });
    expect(out()).toContain('sha256 0123456789ab');
    expect(out()).toContain('shadows a panel router');
  });

  it('prints the refusal findings and fails', async () => {
    const client = makeClient();
    client.traefik.customConfig.set.mockRejectedValueOnce(
      new NineDeployError(400, 'invalid_custom_config', 'name must start with custom-', {
        errors: [issue('name must start with custom-')],
        warnings: [issue('w1')],
      }),
    );
    await proxyConfigSet(client as never, { file });
    expect(out()).toContain('Errors');
    expect(out()).toContain('w1');
    expect(err()).toContain('name must start with custom-');
    expect(process.exitCode).toBe(1);
    client.traefik.customConfig.set.mockRejectedValueOnce(new NineDeployError(503, 'traefik_validation_unavailable', 'unavailable'));
    await proxyConfigSet(client as never, { file });
    expect(err()).toContain('unavailable');
  });
});

describe('proxy config clear', () => {
  it('asks for confirmation, then clears', async () => {
    const client = makeClient();
    h.prompt.mockResolvedValueOnce('no');
    await proxyConfigClear(client as never);
    expect(out()).toContain('Aborted');
    expect(client.traefik.customConfig.clear).not.toHaveBeenCalled();
    h.prompt.mockResolvedValueOnce('clear');
    client.traefik.customConfig.clear.mockResolvedValueOnce({ ok: true, cleared: true });
    await proxyConfigClear(client as never);
    expect(out()).toContain('Custom config removed');
    client.traefik.customConfig.clear.mockResolvedValueOnce({ ok: true, cleared: false });
    await proxyConfigClear(client as never, { yes: true });
    expect(out()).toContain('no custom config to remove');
    client.traefik.customConfig.clear.mockRejectedValue(new Error('denied'));
    await proxyConfigClear(client as never, { yes: true });
    expect(err()).toContain('denied');
  });
});
