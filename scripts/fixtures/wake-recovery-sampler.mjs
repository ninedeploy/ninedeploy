import http from 'node:http';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

/** A generic proxy 503 is not the keyed catcher's retry page. Never retain response bodies. */
export function sampleWakePage(options = {}) {
  return new Promise(resolve => {
    const at = Date.now();
    let deadline;
    const finish = row => { clearTimeout(deadline); resolve(row); };
    const request = http.get({ hostname: 'ninedeploy-proxy', path: '/dashboard', headers: { host: 'wake.invalid' }, ...options }, response => {
      let body = '', oversized = false;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (body.length + chunk.length > 16_384) oversized = true;
        if (!oversized) body += chunk;
      });
      response.on('end', () => finish({ at, status: response.statusCode,
        waking: !oversized && response.headers['retry-after'] === '5' && body.includes('Waking up') && body.includes('http-equiv="refresh"') }));
      response.on('error', error => finish({ at, status: 0, waking: false, error: error.code ?? 'RESPONSE_ERROR' }));
    });
    // An idle socket timeout alone can be kept alive forever by a streaming body.
    deadline = setTimeout(() => request.destroy(Object.assign(new Error('timeout'), { code: 'PROBE_TIMEOUT' })), 1000);
    request.on('error', error => finish({ at, status: 0, waking: false, error: error.code ?? 'REQUEST_ERROR' }));
  });
}

if (process.argv[2] === 'probe') {
  const row = await sampleWakePage();
  console.log(JSON.stringify(row));
  process.exitCode = row.status === 503 && row.waking ? 0 : 1;
} else if (process.argv[2] === 'sample') {
  const rows = [];
  while (!existsSync('/proof/stop')) {
    const row = await sampleWakePage();
    rows.push(row);
    appendFileSync('/proof/traffic.jsonl', `${JSON.stringify(row)}\n`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  writeFileSync('/proof/samples.json', JSON.stringify(rows));
}
