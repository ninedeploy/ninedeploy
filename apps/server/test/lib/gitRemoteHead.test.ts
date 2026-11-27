/**
 * X2: `remoteBranchHead` (lib/git.ts) reads a branch's head with `git ls-remote`, and with nothing else.
 * The git calls are real; where they go is a repository this test creates.
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});

const { prepareRemoteHeadCommand, remoteBranchHead } = await import('../../src/lib/git.js');
const egress = await import('../../src/lib/gitEgress.js');

interface Repo {
  bare: string;
  main: string;
  other: string;
  url: string;
  /** The Authorization header of the last request git sent. */
  authorization: () => string | undefined;
}

let root: string;
let servers: Server[] = [];
let egressBefore: string | undefined;
let prepared: string[] = [];

const callDirectories = () => readdirSync(tmpdir()).filter((name) => name.startsWith('ninedeploy-ls-remote-'));

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'nd-remote-head-'));
  egressBefore = process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
  // The repository is this machine's own; the egress gate is exercised apart, below.
  process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  servers = [];
  if (egressBefore === undefined) delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
  else process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = egressBefore;
  for (const dir of prepared) rmSync(dir, { recursive: true, force: true });
  prepared = [];
  rmSync(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  const result = spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args],
    { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true } satisfies SpawnSyncOptions,
  );
  if (result.status !== 0 || result.error) throw new Error(result.stderr || String(result.error) || `git ${args[0]} failed`);
  return result.stdout.trim();
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * A bare repository with a `main` branch and one other, served through git's own
 * http-backend on this machine. `token`: the server answers 401 to any request
 * that does not carry it, as a private repository does.
 */
async function repository(token?: string): Promise<Repo> {
  const work = path.join(root, 'work');
  const bare = path.join(root, 'repo.git');
  mkdirSync(work, { recursive: true });
  git(['init', '-b', 'main'], work);
  writeFileSync(path.join(work, 'README.md'), 'one\n');
  git(['add', 'README.md'], work);
  git(['commit', '-m', 'First'], work);
  const main = git(['rev-parse', 'HEAD'], work);
  git(['switch', '-c', 'other'], work);
  writeFileSync(path.join(work, 'README.md'), 'two\n');
  git(['add', 'README.md'], work);
  git(['commit', '-m', 'Second'], work);
  const other = git(['rev-parse', 'HEAD'], work);
  git(['clone', '--bare', '--no-hardlinks', work, bare], root);
  let authorization: string | undefined;
  const expected = token ? `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` : undefined;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fixture.invalid');
      authorization = req.headers.authorization;
      const allowed = (req.method === 'GET' && url.pathname === '/repo.git/info/refs') || (req.method === 'POST' && url.pathname === '/repo.git/git-upload-pack');
      if (expected && authorization !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="NineDeploy test"' });
        res.end();
        return;
      }
      if (!allowed) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const input = req.method === 'POST' ? await body(req) : undefined;
      const result = spawnSync('git', ['-c', 'safe.directory=*', 'http-backend'], {
        cwd: bare,
        windowsHide: true,
        timeout: 30_000,
        input,
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method ?? 'GET',
          REMOTE_ADDR: '127.0.0.1',
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          CONTENT_LENGTH: input ? String(input.length) : '',
          HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
        },
      });
      const out = result.stdout;
      const boundary = out ? out.indexOf('\r\n\r\n') : -1;
      if (result.status !== 0 || !out || boundary < 0) {
        res.statusCode = 502;
        res.end();
        return;
      }
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of out.subarray(0, boundary).toString().split('\r\n')) {
        const colon = line.indexOf(':');
        const value = line.slice(colon + 1).trim();
        if (line.toLowerCase().startsWith('status:')) status = Number(value.split(' ')[0]);
        else if (colon > 0) headers[line.slice(0, colon)] = value;
      }
      res.writeHead(status, headers);
      res.end(out.subarray(boundary + 4));
    })().catch(() => {
      res.statusCode = 502;
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the fixture server has no port');
  return { bare, main, other, url: `http://127.0.0.1:${address.port}/repo.git`, authorization: () => authorization };
}

describe('the call remoteBranchHead assembles', () => {
  /** The gate is answered without a name lookup: what the call is made of is what is under test. */
  function pin(addresses: string[] = ['203.0.113.7']) {
    return vi.spyOn(egress, 'vetCloneTarget').mockResolvedValue({ host: 'git.example.com', port: 443, addresses });
  }
  async function prepare(repoUrl: string, branch: string, creds?: Parameters<typeof prepareRemoteHeadCommand>[2]) {
    const command = await prepareRemoteHeadCommand(repoUrl, branch, creds);
    prepared.push(command.cwd);
    return command;
  }

  it('puts the token in the URL, the checkout settings in -c options, and nothing of the panel in the environment', async () => {
    const vet = pin();
    const command = await prepare('https://git.example.com/acme/web.git', 'main', { type: 'custom', token: 'a-test-token' });
    expect(vet).toHaveBeenCalledWith('https://git.example.com/acme/web.git');
    expect(command.args).toEqual([
      // No credential helper is consulted or told, whatever the host configured.
      '-c',
      'credential.helper=',
      '-c',
      'http.followRedirects=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'http.curloptResolve=git.example.com:443:203.0.113.7',
      // `--` ends the options: the repository can never be read as one.
      'ls-remote',
      '--',
      'https://x-access-token:a-test-token@git.example.com/acme/web.git',
      'refs/heads/main',
    ]);
    expect(command.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(Object.keys(command.env).filter((name) => /^NINEDEPLOY|^NODE_|SECRET|KEY|TOKEN/i.test(name))).toEqual([]);
    expect(command.keyFile).toBeUndefined();
    expect(readdirSync(command.cwd)).toEqual([]);
  });

  it('names a GitLab token as GitLab takes it, and leaves no key for a repository reached over HTTPS', async () => {
    pin();
    const command = await prepare('https://gitlab.example.com/acme/web.git', 'main', { type: 'gitlab', token: 'gl-token', deployKey: 'unused' });
    expect(command.args.at(-2)).toBe('https://oauth2:gl-token@gitlab.example.com/acme/web.git');
    expect(command.args.some((arg) => arg.startsWith('core.sshCommand='))).toBe(false);
    expect(command.keyFile).toBeUndefined();
  });

  it('writes the deploy key for the call, with the host keys it was given, and has ssh use them', async () => {
    pin();
    const creds = { deployKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nKEY\n-----END OPENSSH PRIVATE KEY-----\n', pinHostKeys: true, hostKeys: 'git.example.com ssh-ed25519 AAAATEST\n' };
    const command = await prepare('https://git.example.com/acme/web.git', 'release/v1.0', creds);
    expect(command.args.slice(-3)).toEqual(['--', 'git@git.example.com:acme/web.git', 'refs/heads/release/v1.0']);
    const ssh = command.args.find((arg) => arg.startsWith('core.sshCommand='))?.slice('core.sshCommand='.length);
    expect(ssh).toBe(`ssh -i "${command.keyFile}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o HashKnownHosts=no -o UserKnownHostsFile="${command.knownHostsFile}"`);
    expect(path.dirname(command.keyFile!)).toBe(command.cwd);
    expect(readFileSync(command.keyFile!, 'utf8')).toBe(creds.deployKey);
    expect(readFileSync(command.knownHostsFile, 'utf8')).toBe('git.example.com ssh-ed25519 AAAATEST\n');
    expect(readdirSync(command.cwd).sort()).toEqual(['key', 'known_hosts']);
    // No token anywhere, and the directory of the call holds nothing else.
    expect(command.args.join(' ')).not.toContain('PRIVATE KEY');
    // The key is for its owner alone (a Windows directory has no such mode).
    if (process.platform !== 'win32') expect(readFileSync(command.keyFile!).mode & 0o777).toBe(0o600);
  });

  it("carries the host's proxy and certificate settings, and no other variable", async () => {
    pin();
    const before = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://proxy.example.com:3128';
    try {
      const command = await prepare('https://git.example.com/acme/web.git', 'main');
      // What this machine sets for git's network is passed on, and nothing else:
      // no proxy setting of the panel's own, no key, no token.
      const network = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'GIT_SSL_CAINFO', 'SSL_CERT_FILE'];
      const expected: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
      for (const name of network) if (process.env[name]) expected[name] = process.env[name]!;
      expect(command.env).toEqual(expected);
      expect(command.env.HTTPS_PROXY).toBe('http://proxy.example.com:3128');
      // No credential: the repository is read as it is.
      expect(command.args.at(-2)).toBe('https://git.example.com/acme/web.git');
    } finally {
      if (before === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = before;
    }
  });

  it('refuses a branch it cannot hand to git as a pattern, before the egress gate runs', async () => {
    const vet = pin();
    for (const branch of ['-oProxyCmd=anything', '--upload-pack=anything', 'a b', 'main;reboot', '..', '', 'a\nb', 'release.*', '$(id)', 'a\\b']) {
      await expect(prepare('https://git.example.com/acme/web.git', branch), JSON.stringify(branch)).rejects.toThrow(/Refusing to read a branch of that shape/);
    }
    expect(vet).not.toHaveBeenCalled();
  });
});

describe('remoteBranchHead', () => {
  it("reads the head of a branch from a repository on this machine, and null for a branch that is not there", async () => {
    const repo = await repository();
    expect(await remoteBranchHead(repo.bare, 'main')).toBe(repo.main);
    expect(await remoteBranchHead(repo.bare, 'other')).toBe(repo.other);
    expect(await remoteBranchHead(repo.bare, 'feature/no-such-branch')).toBeNull();
    // Nothing was left behind: no key, no known_hosts, no directory of the call.
    expect(callDirectories()).toEqual([]);
  });

  it('reads a private repository over HTTP with the token, and keeps the token out of the credential store', async () => {
    const repo = await repository('a-test-token');
    expect(await remoteBranchHead(repo.url, 'main', { type: 'github', token: 'a-test-token' })).toBe(repo.main);
    // A host may have a storing credential helper (Git for Windows ships one). Without the
    // call's own `credential.helper=`, the token would be kept after that first call, and
    // this second one would succeed on it. It must not.
    await expect(remoteBranchHead(repo.url, 'main')).rejects.toThrow(/git ls-remote failed for http:\/\/127\.0\.0\.1:\d+\/repo\.git/);
  });

  it("goes through the egress gate first, and a remote it refuses is never asked", async () => {
    delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
    await expect(remoteBranchHead('http://127.0.0.1:9/repo.git', 'main', undefined, { timeoutMs: 3000 })).rejects.toThrow(/private|loopback|link-local/i);
  });

  it('never lets the token out in an error: git repeats the URL it was given', async () => {
    // Nothing listens there: git fails, and names the URL with its userinfo.
    const failed = await remoteBranchHead('http://127.0.0.1:9/repo.git', 'main', { type: 'custom', token: 'secret-token-value' }, { timeoutMs: 5000 }).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    expect(failed).toMatch(/git ls-remote failed for http:\/\/127\.0\.0\.1:9\/repo\.git/);
    // The URL is named with its userinfo, and the token's place held by stars.
    expect(failed).toContain('x-access-token:***@127.0.0.1:9');
    expect(failed).not.toContain('secret-token-value');
    expect(failed).not.toContain(encodeURIComponent('secret-token-value'));
    expect(callDirectories()).toEqual([]);
  });

  it('stops when the call is not answered in time, and leaves nothing behind', async () => {
    const silent = createServer(() => undefined);
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const address = silent.address();
    if (!address || typeof address === 'string') throw new Error('the fixture server has no port');
    // Where a process group cannot be signalled (Windows), git's helper ends when the connection does.
    const drop = setTimeout(() => silent.closeAllConnections(), 3000);
    const started = Date.now();
    try {
      await expect(remoteBranchHead(`http://127.0.0.1:${address.port}/repo.git`, 'main', undefined, { timeoutMs: 1500 })).rejects.toThrow(/timed out|timeout|killed/i);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      clearTimeout(drop);
    }
    expect(callDirectories()).toEqual([]);
  });
});
