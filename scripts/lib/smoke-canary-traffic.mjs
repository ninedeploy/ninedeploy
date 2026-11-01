/** Start the synthetic traffic collector used by public node canary acceptance. */
export async function startCanaryTraffic({ inner, until, client, fixtureImage, hostname }) {
  const code = canaryTrafficCode(hostname);
  inner(['run', '-d', '--name', client, '--network', 'ninedeploy', '--entrypoint', 'node', fixtureImage, '-e', code]);
  await until(() => inner(['exec', client, 'test', '-f', '/tmp/r1-traffic-ready'], { allowFailure: true }).status === 0,
    `traffic baseline ${client}`, 30_000);
}

export function canaryTrafficCode(hostname) {
  return `const http = require('node:http'), fs = require('node:fs');
const records = []; let stopped = false;
async function tick() {
  if (stopped) return;
  try {
    records.push(await new Promise((resolve, reject) => {
      const q = http.request({ hostname: 'ninedeploy-proxy', port: 80, path: '/', headers: { host: ${JSON.stringify(hostname)} } }, r => {
        let body = ''; r.on('data', c => body += c);
        r.on('end', () => resolve({ at: Date.now(), status: r.statusCode, body }));
      });
      q.setTimeout(1500, () => q.destroy(Error('timeout'))); q.on('error', reject); q.end();
    }));
  } catch (e) { records.push({ at: Date.now(), error: e.message }); }
  // Confirm actual collection before the harness submits even a fast-refused deploy.
  if (records.length === 20) fs.writeFileSync('/tmp/r1-traffic-ready', 'ready');
  setTimeout(tick, 50);
}
process.on('SIGTERM', () => {
  stopped = true; fs.writeFileSync('/tmp/r1-traffic.json', JSON.stringify(records)); process.exit(0);
});
tick();`;
}
