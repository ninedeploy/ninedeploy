import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  githubAppAddManual,
  githubAppList,
  githubAppRemove,
  githubAppRotateKey,
  githubAppShow,
  githubAppSync,
  serviceGithub,
} from '../src/commands/githubApps.js';

/** 0.13: `ninedeploy github-app …` and `ninedeploy services github <id>`. */

const h = vi.hoisted(() => ({ prompt: vi.fn(), loadConfig: vi.fn() }));
vi.mock('../src/prompts.js', () => ({ prompt: h.prompt, promptHidden: vi.fn() }));
vi.mock('../src/config.js', () => ({ loadConfig: h.loadConfig, saveConfig: vi.fn() }));

const ESC = String.fromCharCode(27);

const APP = {
  id: 1,
  name: `Nine${ESC}]8;;https://evil.example${String.fromCharCode(7)}Deploy`,
  appId: 4242,
  slug: 'ninedeploy',
  clientId: null,
  ownerLogin: 'acme',
  ownerType: 'Organization',
  webBaseUrl: 'https://github.com',
  apiBaseUrl: 'https://api.github.com',
  htmlUrl: 'https://github.com/apps/ninedeploy',
  permissions: null,
  events: null,
  webhookUrl: 'https://panel.example/v1/hooks/github-app/abc',
  installUrl: 'https://github.com/apps/ninedeploy/installations/new',
  hasPrivateKey: true,
  hasClientSecret: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

const INST = {
  id: 10,
  githubAppId: 1,
  installationId: 555,
  accountLogin: `acme${ESC}[5m`,
  accountType: 'Organization',
  accountId: 9,
  repositorySelection: 'selected',
  permissions: null,
  sourceId: 7,
  suspendedAt: null,
  removedAt: null,
  configureUrl: null,
  createdAt: '',
  updatedAt: '',
};

const LINK = {
  id: 1,
  serviceId: 5,
  installationRowId: 10,
  githubAppId: 1,
  sourceId: 7,
  repoId: 77,
  repoFullName: `acme/web${ESC}[2J`,
  enabled: true,
  tokenScope: 'repository',
  watchPaths: null,
  reportStatus: true,
  prComment: false,
  previousSourceId: 2,
  active: true,
  createdAt: '',
  updatedAt: '',
};

function makeClient() {
  return {
    githubApps: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      rotateKey: vi.fn(),
      remove: vi.fn(),
      syncInstallations: vi.fn(),
      installations: vi.fn(),
    },
    services: { github: { get: vi.fn(), migrate: vi.fn(), feedback: vi.fn(), finalize: vi.fn(), unlink: vi.fn() } },
  };
}

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
  h.prompt.mockResolvedValue('');
  h.loadConfig.mockReturnValue({ baseUrl: 'https://panel.example/' });
  delete process.env['NINEDEPLOY_GITHUB_APP_KEY'];
  delete process.env['NINEDEPLOY_GITHUB_APP_WEBHOOK_SECRET'];
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('github-app list / show', () => {
  it('points at the panel when no App exists', async () => {
    const client = makeClient();
    client.githubApps.list.mockResolvedValue([]);
    await githubAppList(client as never);
    expect(out()).toContain('https://panel.example/sources → GitHub Apps → Create GitHub App');
    expect(out()).toContain('github-app add-manual');
  });

  it('lists Apps with provider text stripped of terminal controls', async () => {
    const client = makeClient();
    client.githubApps.list.mockResolvedValue([APP, { ...APP, id: 2, ownerLogin: null, webBaseUrl: 'https://ghe.example' }]);
    await githubAppList(client as never);
    expect(out()).toContain('NineDeploy');
    expect(out()).not.toContain(`${ESC}]8`);
    expect(out()).toContain('ghe.example');
  });

  it('shows an App with its installations, and every installation state', async () => {
    const client = makeClient();
    client.githubApps.get.mockResolvedValue(APP);
    client.githubApps.installations.mockResolvedValue([
      INST,
      { ...INST, id: 11, accountLogin: null, accountType: null, sourceId: null, suspendedAt: '2026-10-02' },
      { ...INST, id: 12, removedAt: '2026-10-03' },
    ]);
    await githubAppShow(client as never, '1');
    const text = out();
    expect(text).toContain('acme (Organization)');
    expect(text).toContain('https://panel.example/v1/hooks/github-app/abc');
    expect(text).toContain('installation 555');
    expect(text).toContain('suspended');
    expect(text).toContain('removed');
    expect(text).not.toContain(`${ESC}[5m`);
  });

  it('shows an App without optional metadata and without installations', async () => {
    const client = makeClient();
    client.githubApps.get.mockResolvedValue({ ...APP, slug: null, ownerLogin: null, installUrl: null, hasPrivateKey: false });
    client.githubApps.installations.mockResolvedValue([]);
    await githubAppShow(client as never, '1');
    expect(out()).toContain('missing');
    expect(out()).toContain('No installations yet');
  });

  it('owner without a type, a bad id, and an API error', async () => {
    const client = makeClient();
    client.githubApps.get.mockResolvedValue({ ...APP, ownerType: null });
    client.githubApps.installations.mockResolvedValue([]);
    await githubAppShow(client as never, '1');
    expect(out()).toContain('acme');
    await githubAppShow(client as never, '0x1');
    expect(err()).toContain('Usage: ninedeploy github-app show <id>');
    client.githubApps.get.mockRejectedValue(new Error('GitHub App not found'));
    await githubAppShow(client as never, '9');
    expect(err()).toContain('GitHub App not found');
  });
});

describe('github-app add-manual', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nd-gh-app-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the key from --key-file and sends GHES base URLs', async () => {
    const keyFile = path.join(dir, 'app.pem');
    writeFileSync(keyFile, '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n');
    const client = makeClient();
    client.githubApps.create.mockResolvedValue(APP);
    await githubAppAddManual(client as never, {
      name: 'ghes',
      appId: '12',
      keyFile,
      webBaseUrl: 'https://ghe.example',
      apiBaseUrl: 'https://ghe.example/api/v3',
    });
    expect(client.githubApps.create).toHaveBeenCalledWith({
      name: 'ghes',
      appId: 12,
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
      webBaseUrl: 'https://ghe.example',
      apiBaseUrl: 'https://ghe.example/api/v3',
    });
    expect(out()).toContain('generated a webhook secret');
    expect(out()).toContain('github-app sync 1');
  });

  it('prompts for name and id, takes the key and webhook secret from the environment', async () => {
    process.env['NINEDEPLOY_GITHUB_APP_KEY'] = '-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----';
    process.env['NINEDEPLOY_GITHUB_APP_WEBHOOK_SECRET'] = 'whsec';
    h.prompt.mockResolvedValueOnce('gh').mockResolvedValueOnce('3');
    const client = makeClient();
    client.githubApps.create.mockResolvedValue({ ...APP, installUrl: null });
    await githubAppAddManual(client as never);
    expect(client.githubApps.create).toHaveBeenCalledWith({
      name: 'gh',
      appId: 3,
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
      webhookSecret: 'whsec',
    });
    expect(out()).not.toContain('generated a webhook secret');
  });

  it('refuses missing input before calling the API', async () => {
    const client = makeClient();
    await githubAppAddManual(client as never, {});
    expect(err()).toContain('A name is required');
    await githubAppAddManual(client as never, { name: 'x', appId: 'abc' });
    expect(err()).toContain('numeric GitHub App ID');
    await githubAppAddManual(client as never, { name: 'x', appId: '1', webBaseUrl: 'https://ghe.example' });
    expect(err()).toContain('go together');
    await githubAppAddManual(client as never, { name: 'x', appId: '1' });
    expect(err()).toContain('A private key is required');
    await githubAppAddManual(client as never, { name: 'x', appId: '1', keyFile: path.join(dir, 'missing.pem') });
    expect(err()).toContain('Could not read the private key');
    expect(client.githubApps.create).not.toHaveBeenCalled();
  });

  it('prints the server refusal', async () => {
    process.env['NINEDEPLOY_GITHUB_APP_KEY'] = 'PEM';
    const client = makeClient();
    client.githubApps.create.mockRejectedValue('privateKey must be a PEM private key');
    await githubAppAddManual(client as never, { name: 'x', appId: '1' });
    expect(err()).toContain('privateKey must be a PEM private key');
  });
});

describe('github-app sync / rotate-key / remove', () => {
  it('syncs and prints counts, the truncation note and installations', async () => {
    const client = makeClient();
    client.githubApps.syncInstallations.mockResolvedValue({ created: 1, updated: 0, removed: 0, sourcesCreated: 1, truncated: true, installations: [INST] });
    await githubAppSync(client as never, '1');
    expect(out()).toContain('1 new, 0 updated, 0 removed; 1 source(s) created');
    expect(out()).toContain('page cap');
    client.githubApps.syncInstallations.mockResolvedValue({ created: 0, updated: 0, removed: 0, sourcesCreated: 0, truncated: false, installations: [] });
    logSpy.mockClear();
    await githubAppSync(client as never, '1');
    expect(out()).not.toContain('page cap');
    client.githubApps.syncInstallations.mockRejectedValue(new Error('GitHub refused the App credentials'));
    await githubAppSync(client as never, '1');
    expect(err()).toContain('GitHub refused the App credentials');
    await githubAppSync(client as never, 'x');
    expect(err()).toContain('Usage: ninedeploy github-app sync <id>');
  });

  it('rotates the key from the environment, and reports failures', async () => {
    const client = makeClient();
    await githubAppRotateKey(client as never, 'x');
    expect(err()).toContain('Usage');
    await githubAppRotateKey(client as never, '1');
    expect(err()).toContain('A private key is required');
    await githubAppRotateKey(client as never, '1', { keyFile: path.join(tmpdir(), 'nd-definitely-missing.pem') });
    expect(err()).toContain('Could not read the private key');
    process.env['NINEDEPLOY_GITHUB_APP_KEY'] = 'NEWPEM';
    client.githubApps.rotateKey.mockResolvedValueOnce(APP).mockRejectedValueOnce(new Error('different GitHub App'));
    await githubAppRotateKey(client as never, '1');
    expect(client.githubApps.rotateKey).toHaveBeenCalledWith(1, 'NEWPEM');
    expect(out()).toContain('Private key replaced');
    await githubAppRotateKey(client as never, '1');
    expect(err()).toContain('different GitHub App');
  });

  it('removes after typed confirmation or --yes, and aborts otherwise', async () => {
    const client = makeClient();
    await githubAppRemove(client as never, '-1');
    expect(err()).toContain('Usage');
    await githubAppRemove(client as never, '1');
    expect(out()).toContain('Aborted.');
    expect(client.githubApps.remove).not.toHaveBeenCalled();
    h.prompt.mockResolvedValueOnce('delete');
    client.githubApps.remove.mockResolvedValue(undefined);
    await githubAppRemove(client as never, '1');
    expect(out()).toContain('GitHub App #1 removed.');
    client.githubApps.remove.mockRejectedValue(new Error('busy'));
    await githubAppRemove(client as never, '1', { yes: true });
    expect(err()).toContain('busy');
  });
});

describe('services github', () => {
  it('shows the link (sanitised) and an unlinked service', async () => {
    const client = makeClient();
    client.services.github.get.mockResolvedValueOnce({ link: LINK }).mockResolvedValueOnce({ link: null });
    await serviceGithub(client as never, '5');
    expect(out()).toContain('acme/web');
    expect(out()).not.toContain(`${ESC}[2J`);
    expect(out()).toContain('active (App webhooks deploy it)');
    await serviceGithub(client as never, '5');
    expect(out()).toContain('Not linked');
  });

  it('describes inactive and disabled links', async () => {
    const client = makeClient();
    client.services.github.get
      .mockResolvedValueOnce({ link: { ...LINK, active: false, reportStatus: false, prComment: true, sourceId: null, previousSourceId: null } })
      .mockResolvedValueOnce({ link: { ...LINK, active: false, enabled: false } });
    await serviceGithub(client as never, '5');
    expect(out()).toContain('inactive (installation suspended or removed)');
    await serviceGithub(client as never, '5');
    expect(out()).toContain('disabled');
  });

  it('migrates, sets feedback and finalizes in order', async () => {
    const client = makeClient();
    client.services.github.migrate.mockResolvedValue({ link: LINK });
    client.services.github.feedback.mockResolvedValue({ link: LINK });
    client.services.github.finalize.mockResolvedValue({ link: LINK, webhooksDeactivated: 2 });
    client.services.github.get.mockResolvedValue({ link: LINK });
    await serviceGithub(client as never, '5', { migrate: '7', status: 'ON', prComment: 'off', finalize: true });
    expect(client.services.github.migrate).toHaveBeenCalledWith(5, 7);
    expect(client.services.github.feedback).toHaveBeenCalledWith(5, { reportStatus: true, prComment: false });
    expect(client.services.github.finalize).toHaveBeenCalledWith(5);
    expect(client.services.github.migrate.mock.invocationCallOrder[0]!).toBeLessThan(client.services.github.feedback.mock.invocationCallOrder[0]!);
    expect(out()).toContain('2 webhook(s) switched off');
    await serviceGithub(client as never, '5', { prComment: 'on' });
    expect(client.services.github.feedback).toHaveBeenLastCalledWith(5, { prComment: true });
  });

  it('unlinks on its own and surfaces the 409 reason', async () => {
    const client = makeClient();
    client.services.github.unlink
      .mockResolvedValueOnce({ ok: true, sourceId: 2, webhooksReactivated: 1 })
      .mockResolvedValueOnce({ ok: true, sourceId: null, webhooksReactivated: 0 })
      .mockRejectedValueOnce(new Error('This service clones through the GitHub App source itself'));
    await serviceGithub(client as never, '5', { unlink: true });
    expect(out()).toContain('Source is now 2; 1 webhook(s) switched back on');
    await serviceGithub(client as never, '5', { unlink: true });
    expect(out()).toContain('Source is now none');
    await serviceGithub(client as never, '5', { unlink: true });
    expect(err()).toContain('clones through the GitHub App source itself');
    expect(client.services.github.get).not.toHaveBeenCalled();
  });

  it('refuses bad input', async () => {
    const client = makeClient();
    await serviceGithub(client as never, 'abc');
    expect(err()).toContain('Usage: ninedeploy services github <id>');
    await serviceGithub(client as never, '5', { status: 'yes' });
    expect(err()).toContain('--status takes on or off');
    await serviceGithub(client as never, '5', { prComment: '1' });
    expect(err()).toContain('--pr-comment takes on or off');
    await serviceGithub(client as never, '5', { migrate: 'x' });
    expect(err()).toContain('Invalid --migrate source id');
    await serviceGithub(client as never, '5', { unlink: true, finalize: true });
    expect(err()).toContain('--unlink runs on its own');
    expect(client.services.github.get).not.toHaveBeenCalled();
  });
});
