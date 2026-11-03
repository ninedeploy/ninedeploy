import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { automaticSleepControl } from '../../../scripts/lib/smoke-node-automatic-sleep.mjs';

it.each([
  ['healthy application', 200, 'old', true], ['unhealthy status', 503, 'old', false],
  ['different backend', 200, 'other', false], ['oversized body', 200, 'old'.repeat(6000), false],
] as const)('targets the application Host and verifies exact bounded HTTP: %s', async (_label, status, body, application) => {
  const hosts: string[] = [];
  const server = createServer((req, res) => {
    hosts.push(req.headers.host!); res.statusCode = req.headers.host === 'app.test' ? status : 404; res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, ['-e', automaticSleepControl('app.test', '127.0.0.1', (server.address() as { port: number }).port)], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      const code = await new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('close', resolve); });
      expect(code, stderr).toBe(application ? 0 : 1); expect(JSON.parse(stdout)).toEqual({ status, application });
      expect(hosts).toEqual(['app.test']);
    } finally { clearTimeout(timer); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
