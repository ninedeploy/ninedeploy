import assert from 'node:assert/strict';

/**
 * R2 node RPS autoscaling with default panel settings: public API, sealed node agent, consumed
 * serving-traffic windows and Traefik on isolated daemons. 1→2 under load, a source-loss control that
 * must hold (never read as zero), then 2→1 on verified low traffic.
 */
export async function smokeNodeAutoscaleRps({ api, inner, id, fixtureImage, service, domain, until, pause, report, cleared, success, scaleSettled, restartAgent, holdMs = 90_000, saveTraffic = () => {} }) {
  const cfg = target => ({ minReplicas: 1, maxReplicas: 2, metric: 'rps', target, scaleUpSeconds: 30, scaleDownSeconds: 60 });
  const initial = await service(id);
  const client = `nd-autoscale-client-${id}`;
  // A sequential client whose pause between requests is set over /rate; every result is kept.
  const script = `const http=require('node:http');let stopped=false,gap=1000;const records=[];
    async function tick(){if(stopped)return;try{records.push(await new Promise((resolve,reject)=>{const q=http.request({hostname:'ninedeploy-proxy',port:80,path:'/',headers:{host:${JSON.stringify(domain.hostname)}}},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({at:Date.now(),status:r.statusCode,body}))});q.setTimeout(2500,()=>q.destroy(Error('timeout')));q.on('error',reject);q.end()}))}catch(e){records.push({at:Date.now(),error:e.message})}setTimeout(tick,gap)}
    http.createServer((q,r)=>{const u=new URL(q.url,'http://x');if(u.pathname==='/health'){r.end('ok');return}if(u.pathname==='/rate'){gap=Number(u.searchParams.get('gap'));r.end('ok');return}if(u.pathname==='/finish')stopped=true;r.end(JSON.stringify(records))}).listen(8091,'127.0.0.1');tick();`;
  inner(['run', '-d', '--name', client, '--network', 'ninedeploy', '--entrypoint', 'node', fixtureImage, '-e', script]);
  const call = path => inner(['exec', client, 'node', '-e', `fetch('http://127.0.0.1:8091/${path}').then(r=>r.text()).then(console.log)`]).out;
  await until(() => inner(['exec', client, 'node', '-e', "fetch('http://127.0.0.1:8091/health').then(()=>process.exit(0)).catch(()=>process.exit(1))"], { allowFailure: true }).status === 0, 'rps traffic client');
  const rate = gap => assert.equal(call(`rate?gap=${gap}`), 'ok');
  await cleared();
  await api(`/v1/services/${id}`, { method: 'PATCH', body: { autoscale: cfg(5) } });
  // Each failed wait names the last status, so a hold reason reaches the CI log.
  let last = null;
  const status = async () => (last = await api(`/v1/services/${id}/autoscale`));
  const wait = (fn, description, ms) => until(fn, description, ms).catch(error => { throw Error(`${error.message}; last status ${JSON.stringify(last)}`); });
  assert.ok((await status()).supportedMetrics?.includes('rps'), 'the panel must advertise node rps');
  const deploymentId = (await api(`/v1/services/${id}/deploys`, { method: 'POST', body: {} })).deploymentId;
  await success(id, deploymentId);
  await cleared();
  const current = await service(id);
  assert.notEqual(current.runtimeId, initial.runtimeId);
  const names = [current.runtimeId, `${current.runtimeId}-r2`];
  const members = names.map(name => inner(['inspect', name, '--format', '{{.Id}} {{.State.Running}}']).out.split(' '));
  assert.equal(new Set(members.map(item => item[0])).size, 2);
  assert.deepEqual(members.map(item => item[1]), ['true', 'false'], 'prepared spare must begin stopped');
  const running = index => inner(['inspect', members[index][0], '--format', '{{.State.Running}}']).out === 'true';

  // Load: ~20+ requests per second against a target of 5 per replica.
  rate(20);
  const up = await wait(async () => { const value = await status(); return value.replicas === 2 && value.value > 0 ? value : false; }, 'node rps scale-up', 300_000);
  await until(() => running(1), 'started spare');
  const replica = row => row.body.split(':').at(-1);
  await until(() => { const seen = new Set(JSON.parse(call('snapshot')).filter(row => row.status === 200).map(replica));
    return members.every(([containerId]) => seen.has(containerId.slice(0, 12))); }, 'both replicas serving proxy traffic', 90_000);
  await until(scaleSettled, 'scale-up ownership handoff', 120_000);

  // Source loss: low traffic would scale down, but without the observation it must hold, with no value.
  rate(2000);
  await restartAgent(false);
  const lost = await wait(async () => { const value = await status(); return value.value === null && value.holding ? value : false; }, 'held without a serving-traffic source', 120_000);
  const holdUntil = Date.now() + holdMs;
  while (Date.now() < holdUntil) {
    const value = await status();
    assert.equal(value.replicas, 2, 'a lost source must never scale down');
    assert.equal(value.value, null, 'a lost source must never read as a value');
    await pause(5_000);
  }
  assert.ok(running(1), 'the spare keeps serving while the source is lost');

  // Restored: verified low traffic scales down after the window.
  await restartAgent(true);
  const down = await wait(async () => { const value = await status(); return value.replicas === 1 && value.value !== null ? value : false; }, 'node rps scale-down', 360_000);
  await until(() => !running(1), 'stopped spare');
  await until(scaleSettled, 'scale-down ownership handoff', 120_000);
  const records = JSON.parse(call('finish'));
  saveTraffic(records);
  assert.ok(records.length >= 300, 'continuous traffic must cover deploy, load, source loss and scale-down');
  assert.deepEqual(records.filter(row => row.error || row.status !== 200), [], 'all routed requests must succeed');
  const observed = new Set(records.filter(row => row.status === 200).map(replica));
  for (const [containerId] of members) assert.ok(observed.has(containerId.slice(0, 12)), 'both replicas must serve actual proxy traffic');
  report({ case: 'node-autoscale-rps', deploymentId, immutableReplicas: members.map(item => item[0]),
    scaleUp: { replicas: up.replicas, rps: up.value }, sourceLoss: { held: lost.holding, heldMs: holdMs, replicas: 2 },
    scaleDown: { replicas: down.replicas, rps: down.value }, requests: records.length, unexpected502: 0, bothReplicasServed: true });
}
