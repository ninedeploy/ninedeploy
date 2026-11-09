import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { probeContainer } from '../../src/lib/containerProbe.js';
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
it('accepts a final healthy HTTP response after informational early hints', async () => {
  const suffix = randomUUID();
  const network = `nd-audit-hints-${suffix}`;
  const container = `nd-audit-http-${suffix}`;
  let ownsNetwork = false, ownsContainer = false;
  try {
    docker('network', 'create', '--internal', '--label', 'ninedeploy.audit=F1044', network); ownsNetwork = true;
    const server = `IFS= read -r request; case "$request" in *' /hints '*) printf 'HTTP/1.1 103 Early Hints\\r\\nLink: </app.css>; rel=preload\\r\\n\\r\\nHTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nOK';; *) printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nOK';; esac`;
    docker('run', '-d', '--pull=never', '--name', container, '--network', network, '--label', 'ninedeploy.audit=F1044', '--read-only', '--memory', '32m', '--cpus', '0.2', 'busybox:1.36', 'nc', '-lk', '-p', '8080', '-e', 'sh', '-c', server); ownsContainer = true;
    expect(docker('exec', container, 'sh', '-c', 'while ! cat /proc/net/tcp /proc/net/tcp6 | grep -q ":1F90 .* 0A "; do :; done; printf READY')).toBe('READY');
    const sample = async (path: string) => {
      const lines: string[] = [];
      await probeContainer({ name: container, port: 8080, protocol: 'http', path }, line => lines.push(line));
      return JSON.parse(lines.find(line => line.startsWith('ND-PROBE '))!.slice('ND-PROBE '.length));
    };
    const control = await sample('/plain');
    console.log('CONTROL EXPECTED: plain 200 ready | ACTUAL:', control);
    expect(control).toMatchObject({ ready: true, status: 200 });
    const hints = await sample('/hints');
    console.log('EXPECTED: final 200 after 103 is ready | ACTUAL:', hints);
    console.log(hints.ready && hints.status === 200 ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(hints).toMatchObject({ ready: true, status: 200 });
  } finally {
    if (ownsContainer) docker('rm', '-f', container);
    if (ownsNetwork) docker('network', 'rm', network);
  }
}, 30000);
