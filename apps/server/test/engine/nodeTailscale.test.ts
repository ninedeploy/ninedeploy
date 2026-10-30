/**
 * ROADMAP item 11: the tailnet join script runs for real in Bash against fake
 * `sudo`, `tailscale`, `systemctl`, `sysctl` and `tee` binaries, which record
 * what they were asked to do.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeTailscaleCommand, nodeTailscaleScript, parseTailnetIp } from '../../src/engine/serverProvisioner.js';
import { fixtureBash, fixtureBashPath } from '../bashFixture.js';

const bash = fixtureBash(spawnSync);
const bashOk = spawnSync(bash, ['-c', 'true']).status === 0;
const KEY = 'tskey-auth-kAbCdEf12CNTRL-0123456789abcdef';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fakes(ip: string) {
  const dir = mkdtempSync(join(tmpdir(), 'nd-ts-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  spawnSync(bash, ['-c', 'mkdir -p "$1"', 'x', fixtureBashPath(spawnSync, bin, bash)]);
  const log = fixtureBashPath(spawnSync, join(dir, 'calls.log'), bash);
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool('sudo', '[ "$1" = -n ] && shift; exec "$@"');
  tool('systemctl', `echo "systemctl $*" >> "${log}"`);
  tool('sysctl', `echo "sysctl $*" >> "${log}"`);
  tool('tee', `echo "tee $*" >> "${log}"; cat > /dev/null`);
  tool(
    'tailscale',
    [
      `echo "tailscale $*" >> "${log}"`,
      // `up` reads the key from the file it is given, which must exist only during the run.
      `for a in "$@"; do case "$a" in --auth-key=file:*) f="\${a#--auth-key=file:}"; echo "keyfile $(cat "$f")" >> "${log}"; echo "keypath $f" >> "${log}";; esac; done`,
      `[ "$1" = ip ] && echo "${ip}"`,
      'exit 0',
    ].join('\n'),
  );
  return { dir, bin: fixtureBashPath(spawnSync, bin, bash), log: join(dir, 'calls.log') };
}

function runScript(opts: { hostname?: string; loginServer?: string }, stdin: string, ip = '100.64.0.9') {
  const f = fakes(ip);
  const script = join(f.dir, 'join.sh');
  writeFileSync(script, nodeTailscaleScript(opts));
  const res = spawnSync(bash, ['-c', 'export PATH="$1:$PATH"; exec bash "$2"', 'x', f.bin, fixtureBashPath(spawnSync, script, bash)], {
    input: stdin,
    encoding: 'utf8',
    timeout: 30000,
  });
  let calls = '';
  try {
    calls = readFileSync(f.log, 'utf8');
  } catch {
    // nothing ran
  }
  return { ...res, calls };
}

describe.skipIf(!bashOk)('the tailnet join script (ROADMAP item 11)', () => {
  it('joins with the key from stdin through a file, keeps the node DNS, and reports the address', () => {
    const res = runScript({ hostname: 'edge-1', loginServer: 'https://hs.example.com' }, `${KEY}\n`);
    expect(res.status, res.stderr).toBe(0);
    expect(parseTailnetIp(res.stdout)).toBe('100.64.0.9');
    const up = res.calls.split('\n').find((l) => l.startsWith('tailscale up'))!;
    expect(up).toContain('--reset');
    expect(up).toContain('--accept-dns=false');
    expect(up).toContain('--hostname=edge-1');
    expect(up).toContain('--login-server=https://hs.example.com');
    // The key never appears in an argument list, only in the file tailscale reads.
    expect(up).not.toContain(KEY);
    expect(res.calls).toContain(`keyfile ${KEY}`);
    const keyPath = /^keypath (.+)$/m.exec(res.calls)![1]!;
    expect(spawnSync(bash, ['-c', 'test -e "$1"', 'x', keyPath]).status).not.toBe(0);
    expect(res.calls).toContain('tee /etc/sysctl.d/90-ninedeploy-agent-bind.conf');
    expect(res.calls).toContain('sysctl -q -w net.ipv4.ip_nonlocal_bind=1');
    expect(res.stdout).not.toContain(KEY);
  });

  it('leaves hostname and login server to Tailscale when not given', () => {
    const res = runScript({}, `${KEY}\n`);
    expect(res.status, res.stderr).toBe(0);
    const up = res.calls.split('\n').find((l) => l.startsWith('tailscale up'))!;
    expect(up).not.toContain('--hostname');
    expect(up).not.toContain('--login-server');
  });

  it('refuses without a key, and fails when no address comes back', () => {
    const none = runScript({}, '');
    expect(none.status).not.toBe(0);
    expect(none.stderr).toContain('No Tailscale auth key arrived.');
    expect(none.calls).not.toContain('tailscale up');
    const noIp = runScript({}, `${KEY}\n`, '');
    expect(noIp.status).not.toBe(0);
    expect(noIp.stderr).toContain('Tailscale gave this node no IPv4 address.');
  }, 60_000);

  it('quotes the hostname and login server so they stay one word each', () => {
    const script = nodeTailscaleScript({ loginServer: "https://hs.example.com/a'b" });
    expect(script).toContain(`TS_LOGIN_SERVER='https://hs.example.com/a'\\''b'`);
  });
});

describe('the tailnet join command', () => {
  it('carries the script base64 in the argument, leaving stdin to the key', () => {
    const cmd = nodeTailscaleCommand({ hostname: 'edge-1' });
    const m = /^sh -c "\$\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d\)"$/.exec(cmd);
    expect(m).not.toBeNull();
    expect(Buffer.from(m![1]!, 'base64').toString('utf8')).toBe(nodeTailscaleScript({ hostname: 'edge-1' }));
  });

  it('reads only a valid IPv4 address from the output', () => {
    expect(parseTailnetIp('noise\nND_TAILNET_IP=100.101.102.103\n')).toBe('100.101.102.103');
    expect(parseTailnetIp('ND_TAILNET_IP=fd7a:115c::1')).toBeNull();
    expect(parseTailnetIp('ND_TAILNET_IP=999.1.1.1')).toBeNull();
    expect(parseTailnetIp('nothing')).toBeNull();
  });
});
