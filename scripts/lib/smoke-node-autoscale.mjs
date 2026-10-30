import assert from 'node:assert/strict';

/** Public API, sealed node agent, real resource samples and Traefik on isolated daemons. */
export async function smokeNodeAutoscale({ api, inner, id, fixtureImage, service, domain, until, report, cleared, success, scaleSettled, saveTraffic = () => {} }) {
  const cfg = target => ({ minReplicas: 1, maxReplicas: 2, metric: 'memory', target, scaleUpSeconds: 30, scaleDownSeconds: 60 });
  const initial = await service(id);
  const client = `nd-autoscale-client-${id}`;
  const script = `const http=require('node:http');let stopped=false;const records=[];
    async function tick(){if(stopped)return;try{records.push(await new Promise((resolve,reject)=>{const q=http.request({hostname:'ninedeploy-proxy',port:80,path:'/',headers:{host:${JSON.stringify(domain.hostname)}}},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({at:Date.now(),status:r.statusCode,body}))});q.setTimeout(2500,()=>q.destroy(Error('timeout')));q.on('error',reject);q.end()}))}catch(e){records.push({at:Date.now(),error:e.message})}setTimeout(tick,100)}
    http.createServer((q,r)=>{if(q.url==='/health'){r.end('ok');return}if(q.url==='/finish')stopped=true;r.end(JSON.stringify(records))}).listen(8091,'127.0.0.1');tick();`;
  inner(['run', '-d', '--name', client, '--network', 'ninedeploy', '--entrypoint', 'node', fixtureImage, '-e', script]);
  await until(() => inner(['exec', client, 'node', '-e', "fetch('http://127.0.0.1:8091/health').then(()=>process.exit(0)).catch(()=>process.exit(1))"], { allowFailure: true }).status === 0, 'autoscale traffic client');
  await cleared();
  await api(`/v1/services/${id}`, { method: 'PATCH', body: { memLimitMb: 128, autoscale: cfg(1) } });
  const deploymentId = (await api(`/v1/services/${id}/deploys`, { method: 'POST', body: {} })).deploymentId;
  await success(id, deploymentId);
  await cleared();
  const current = await service(id);
  assert.notEqual(current.runtimeId, initial.runtimeId);
  const names = [current.runtimeId, `${current.runtimeId}-r2`];
  const inspect = name => inner(['inspect', name, '--format', '{{.Id}} {{.State.Running}}']).out.split(' ');
  const members = names.map(inspect);
  assert.equal(new Set(members.map(item => item[0])).size, 2);
  assert.deepEqual(members.map(item => item[1]), ['true', 'false'], 'prepared spare must begin stopped');
  const status = () => api(`/v1/services/${id}/autoscale`);
  const up = await until(async () => { const value = await status(); return value.replicas === 2 && value.value > 0 ? value : false; }, 'node memory scale-up', 300_000);
  await until(() => inner(['inspect', members[1][0], '--format', '{{.State.Running}}']).out === 'true', 'started spare');
  const readTraffic = endpoint => JSON.parse(inner(['exec', client, 'node', '-e', `fetch('http://127.0.0.1:8091/${endpoint}').then(r=>r.text()).then(console.log)`]).out);
  await until(() => { const seen = new Set(readTraffic('snapshot').filter(row => row.status === 200).map(row => row.body.split(':').at(-1)));
    return members.every(([containerId]) => seen.has(containerId.slice(0, 12))); }, 'both replicas serving proxy traffic', 90_000);
  await until(scaleSettled, 'scale-up ownership handoff', 120_000);
  await api(`/v1/services/${id}`, { method: 'PATCH', body: { autoscale: cfg(100) } });
  const down = await until(async () => { const value = await status(); return value.replicas === 1 && value.value > 0 ? value : false; }, 'node memory scale-down', 360_000);
  await until(() => inner(['inspect', members[1][0], '--format', '{{.State.Running}}']).out === 'false', 'stopped spare');
  await until(scaleSettled, 'scale-down ownership handoff', 120_000);
  const records = readTraffic('finish');
  saveTraffic(records);
  assert.ok(records.length >= 100, 'continuous traffic must cover deploy and both scale transitions');
  assert.deepEqual(records.filter(row => row.error || row.status !== 200), [], 'all routed requests must succeed');
  const observed = new Set(records.filter(row => row.status === 200).map(row => row.body.split(':').at(-1)));
  for (const [containerId] of members) assert.ok(observed.has(containerId.slice(0, 12)), 'both replicas must serve actual proxy traffic');
  report({ case: 'node-autoscale-memory', deploymentId, immutableReplicas: members.map(item => item[0]),
    scaleUp: { replicas: up.replicas, memoryPercent: up.value }, scaleDown: { replicas: down.replicas, memoryPercent: down.value },
    requests: records.length, unexpected502: 0, bothReplicasServed: true });
}
