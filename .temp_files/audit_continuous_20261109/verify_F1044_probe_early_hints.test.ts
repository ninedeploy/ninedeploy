import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { probeContainer } from '../../apps/server/src/lib/containerProbe.js';
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
it('verifies final HTTP status selection and negative controls in native BusyBox', async () => {
  const id = randomUUID(), network = `nd-audit-hints-${id}`, container = `nd-audit-http-${id}`;
  let ownsNetwork = false, ownsContainer = false;
  try {
    docker('network', 'create', '--internal', '--label', 'ninedeploy.audit=F1044', network); ownsNetwork = true;
    const cases: Array<[string, string, boolean, number | undefined]> = [
      ['plain', 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n', true, 200],
      ['hints', 'HTTP/1.1 103 Early Hints\r\nLink: </a>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n', true, 200],
      ['multiple', 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\n', true, 302],
      ['failure', 'HTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n', false, 503],
      ['unfinished', 'HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\n', false, undefined],
      ['upgrade', 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\nHTTP/1.1 200 OK\r\n\r\n', false, 101],
      ['malformed', 'not HTTP\r\n', false, undefined],
    ];
    // Each fixture response is fed as base64, keeping shell source independent
    // from response punctuation and embedded CR/LF bytes.
    const branches = cases.map(([route, response]) => `*' /${route} '*) printf %s ${Buffer.from(response).toString('base64')} | base64 -d;;`).join(' ');
    const server = `IFS= read -r request; case "$request" in ${branches} esac`;
    docker('run', '-d', '--pull=never', '--name', container, '--network', network, '--label', 'ninedeploy.audit=F1044', '--read-only', '--memory', '32m', '--cpus', '0.2', 'busybox:1.36', 'nc', '-lk', '-p', '8080', '-e', 'sh', '-c', server); ownsContainer = true;
    expect(docker('exec', container, 'sh', '-c', 'while ! cat /proc/net/tcp /proc/net/tcp6 | grep -q ":1F90 .* 0A "; do :; done; printf READY')).toBe('READY');
    for (const [route, _response, ready, status] of cases) {
      const lines: string[] = [];
      await probeContainer({ name: container, port: 8080, protocol: 'http', path: `/${route}` }, line => lines.push(line));
      const result = JSON.parse(lines.find(line => line.startsWith('ND-PROBE '))!.slice('ND-PROBE '.length));
      expect(result.ready, route).toBe(ready); expect(result.status, route).toBe(status);
    }
    console.log('EXPECTED: 7 native final-status and negative controls | ACTUAL: all passed');
    console.log('FIX VERIFIED');
  } finally {
    if (ownsContainer) docker('rm', '-f', container);
    if (ownsNetwork) docker('network', 'rm', network);
  }
}, 60000);
