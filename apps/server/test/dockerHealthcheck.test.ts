import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** Execute the actual production image check; never maintain a second copy. */
function healthArgs(): string[] {
  const file = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
  const instruction = /HEALTHCHECK[^\r\n]*\\\r?\n\s*CMD ([^\r\n]+)/.exec(file)?.[1];
  if (!instruction) throw Error('Production Docker healthcheck is absent');
  if (instruction.startsWith('[')) {
    const args = JSON.parse(instruction) as string[];
    if (args[0] !== 'node') throw Error('Expected the production Node healthcheck');
    return args.slice(1);
  }
  const script = /^node -e "(.*)"$/.exec(instruction)?.[1];
  if (!script) throw Error('Unrecognized production healthcheck');
  return ['-e', script];
}
describe('packaged image healthcheck', () => {
  it.each(['panel', 'agent'] as const)('probes the configured %s port and endpoint', async role => {
    const paths: string[] = [], expected = role === 'agent' ? '/agent/ping' : '/health';
    const server = createServer((req, res) => { paths.push(req.url!); res.statusCode = req.url === expected ? 200 : 503; res.end('owned health fixture'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, healthArgs(), { windowsHide: true, stdio: 'ignore', env: { ...process.env, NINEDEPLOY_AGENT: role === 'agent' ? '1' : '0', NINEDEPLOY_AGENT_PORT: String(port), NINEDEPLOY_PORT: String(port) } });
        const timer = setTimeout(() => { child.kill(); reject(Error('Healthcheck process deadline')); }, 6000);
        child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('exit', code => { clearTimeout(timer); resolve(code); });
      });
      expect(exit).toBe(0); expect(paths).toEqual([expected]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('fails a real HTTP 503 on the configured panel port', async () => {
    let probes = 0;
    const server = createServer((_req, res) => { probes++; res.writeHead(503); res.end(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, healthArgs(), { windowsHide: true, stdio: 'ignore', env: { ...process.env, NINEDEPLOY_AGENT: '0', NINEDEPLOY_PORT: String((server.address() as AddressInfo).port) } });
        const timer = setTimeout(() => { child.kill(); reject(Error('Healthcheck process deadline')); }, 6000);
        child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('exit', code => { clearTimeout(timer); resolve(code); });
      });
      expect(exit).toBe(1); expect(probes).toBe(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
