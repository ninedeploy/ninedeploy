import assert from 'node:assert/strict';
import http from 'node:http';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

export function sampleApplication({ host = 'sleep.invalid', authorization } = {}) {
  return new Promise(resolve => {
    const at = Date.now(); let timer, settled = false;
    const finish = row => { if (!settled) { settled = true; clearTimeout(timer); resolve(row); } };
    const request = http.get({ hostname: 'ninedeploy-proxy', path: '/', headers: { host, ...(authorization ? { authorization } : {}) } }, response => {
      let body = '', oversized = false;
      response.setEncoding('utf8');
      response.on('data', chunk => { if (body.length + chunk.length > 16_384) oversized = true; if (!oversized) body += chunk; });
      response.on('end', () => finish({ at, status: response.statusCode,
        application: !oversized && response.statusCode === 200 && body === 'owned-sleep-application',
        waking: !oversized && response.statusCode === 503 && response.headers['retry-after'] === '5' && body.includes('Waking up') && body.includes('http-equiv="refresh"') }));
      response.on('error', error => finish({ at, status: 0, application: false, waking: false, error: error.code ?? 'RESPONSE_ERROR' }));
    });
    timer = setTimeout(() => request.destroy(Object.assign(new Error('deadline'), { code: 'PROBE_TIMEOUT' })), 1000);
    request.on('error', error => finish({ at, status: 0, application: false, waking: false, error: error.code ?? 'REQUEST_ERROR' }));
  });
}

if (process.argv[2] === 'probe') {
  const row = await sampleApplication(); console.log(JSON.stringify(row)); process.exitCode = row.application ? 0 : 1;
} else if (process.argv[2] === 'sample') {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = Date.now() + 600_000;
  // Do not invalidate the real idle observation with the sampler's own traffic.
  while (!existsSync('/proof/idle-complete')) { assert.ok(Date.now() < deadline, 'Idle proof deadline'); await pause(100); }
  const rows = [];
  while (!existsSync('/proof/stop')) {
    assert.ok(Date.now() < deadline, 'Traffic proof deadline');
    const row = await sampleApplication(); rows.push(row); appendFileSync('/proof/traffic.jsonl', `${JSON.stringify(row)}\n`);
    await pause(25);
  }
  writeFileSync('/proof/samples.json', JSON.stringify(rows));
}
