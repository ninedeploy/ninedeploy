import assert from 'node:assert/strict';

/** Ordinary panel deployments, through the public API and its real proxy. */
export async function smokePanelHealthModes({ api, primary, id, fixtureImage, domain, until, success, report, saveTraffic }) {
  const client = `nd-health-client-${id}`;
  const script = `const http=require('node:http');let done=false;const records=[];async function tick(){if(done)return;try{records.push(await new Promise((resolve,reject)=>{const q=http.request({hostname:'ninedeploy-traefik',path:'/',headers:{host:${JSON.stringify(domain.hostname)}}},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({status:r.statusCode,body}))});q.setTimeout(2500,()=>q.destroy(Error('timeout')));q.on('error',reject);q.end()}))}catch(e){records.push({error:e.message})}setTimeout(tick,75)}http.createServer((q,r)=>{if(q.url==='/health'){r.end('ok');return}if(q.url==='/finish')done=true;r.end(JSON.stringify(records))}).listen(8091,'127.0.0.1');tick();`;
  primary(['run', '-d', '--name', client, '--network', 'ninedeploy', '--entrypoint', 'node', fixtureImage, '-e', script]);
  const read = endpoint => JSON.parse(primary(['exec', client, 'node', '-e', `fetch('http://127.0.0.1:8091/${endpoint}').then(r=>r.text()).then(console.log)`]).out);
  await until(() => primary(['exec', client, 'node', '-e', "fetch('http://127.0.0.1:8091/health').then(()=>process.exit(0)).catch(()=>process.exit(1))"], { allowFailure: true }).status === 0, 'panel traffic client');
  const delay = await api(`/v1/services/${id}/env`, { method: 'POST', body: { key: 'LISTEN_DELAY_MS', value: '15000' } });
  assert.ok(delay.id);
  const label = await api(`/v1/services/${id}/env`, { method: 'POST', body: { key: 'RELEASE_LABEL', value: 'initial' } });
  const failures = [];
  for (const mode of ['http', 'http-strict', 'tcp', 'running', 'command']) {
    await api(`/v1/services/${id}`, { method: 'PATCH', body: { healthCheck: mode, healthCommand: mode === 'command' ? 'true' : null, healthTimeoutSeconds: 60 } });
    await api(`/v1/services/${id}/env/${label.id}`, { method: 'PATCH', body: { key: 'RELEASE_LABEL', value: mode } });
    const start = read('snapshot').length;
    const deploymentId = (await api(`/v1/services/${id}/deploys`, { method: 'POST', body: {} })).deploymentId;
    await success(id, deploymentId);
    await until(() => read('snapshot').slice(start).some(row => row.status === 200 && row.body === mode), `new ${mode} release serving`);
    const records = read('snapshot').slice(start);
    saveTraffic(mode, records);
    assert.ok(records.length >= 20, 'traffic must span the delayed startup and routing transition');
    const errors = records.filter(row => row.error || row.status !== 200);
    if (errors.length) failures.push({ mode, errors: errors.length, statuses: [...new Set(errors.map(row => row.status ?? row.error))] });
    report({ case: `panel-health-${mode}`, deploymentId, requests: records.length, unexpected502: records.filter(row => row.status === 502).length, errors: errors.length });
  }
  read('finish');
  assert.deepEqual(failures, [], 'all healthcheck modes must preserve successful routed traffic');
}
