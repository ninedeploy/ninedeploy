import assert from 'node:assert/strict';

/** Real SQL readiness and routing on the full panel, agent and private daemon. */
export async function smokeNodeReplicaDatabases({ api, inner, id, first, fixtureImage, service, domain, database, until, pause, report, cleared, env }) {
  const old = await service(id), network = `nd-dbnet-${database.slug}`;
  const names = [old.runtimeId, old.runtimeId + '-r2'];
  const ids = names.map(name => inner(['inspect', name, '--format', '{{.Id}}']).out);
  const running = target => inner(['inspect', target, '--format', '{{.State.Running}}'], { allowFailure: true }).out === 'true';
  const absent = target => inner(['inspect', target], { allowFailure: true }).status !== 0;
  const joined = target => Object.hasOwn(JSON.parse(inner(['inspect', target, '--format', '{{json .NetworkSettings.Networks}}']).out), network);
  const ready = target => JSON.parse(inner(['exec', target, 'node', '-e', "fetch('http://127.0.0.1:8080/ready').then(async r=>console.log(JSON.stringify({status:r.status,...await r.json()})))"]).out);
  const client = 'nd-replica-sql-client';
  const traffic = `const http=require('node:http');let done=false,stopping=false;const records=[];
    async function tick(){if(done)return;try{records.push(await new Promise((resolve,reject)=>{const q=http.request({hostname:'ninedeploy-proxy',path:'/',headers:{host:${JSON.stringify(domain.hostname)}}},r=>{r.resume();r.on('end',()=>resolve({status:r.statusCode,stopping}))});q.setTimeout(2500,()=>q.destroy(Error('timeout')));q.on('error',reject);q.end()}))}catch{records.push({error:true,stopping})}setTimeout(tick,75)}
    http.createServer((q,r)=>{if(q.url==='/expect-stop'){stopping=true;r.end('{}')}else{done=true;r.end(JSON.stringify(records))}}).listen(8091,'127.0.0.1');tick();`;
  inner(['run', '-d', '--name', client, '--network', 'ninedeploy', '--entrypoint', 'node', fixtureImage, '-e', traffic]);
  const route = () => {
    const code = `const http=require('node:http');const q=http.request({hostname:'ninedeploy-proxy',path:'/',headers:{host:${JSON.stringify(domain.hostname)}}},r=>{r.resume();r.on('end',()=>console.log(r.statusCode))});q.setTimeout(2000,()=>q.destroy(Error('timeout')));q.on('error',()=>process.exitCode=1);q.end();`;
    return Number(inner(['exec', client, 'node', '-e', code]).out);
  };
  await cleared();
  assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 2);
  for (const target of ids) {
    assert.equal(joined(target), true);
    assert.deepEqual(ready(target), { status: 200, ready: true, value: 42, replica: target.slice(0, 12) });
  }
  assert.equal(route(), 200);
  report({ case: 'replica-database-sql-readiness', deploymentId: first, replicas: ids.length, sqlValue: 42, allJoinedPrivateDatabaseBridge: true });

  const candidate = async timeout => {
    await api(`/v1/services/${id}`, { method: 'PATCH', body: { healthTimeoutSeconds: timeout } });
    const deploymentId = (await api(`/v1/services/${id}/deploys`, { method: 'POST', body: {} })).deploymentId;
    const members = [old.slug + '-' + deploymentId, old.slug + '-' + deploymentId + '-r2'];
    await until(async () => {
      const job = (await api(`/v1/services/${id}/deploys`)).find(row => row.id === deploymentId);
      assert.notEqual(job?.status, 'failed', 'Candidate failed before both database attachments could be observed');
      return members.every(member => running(member) && joined(member));
    }, 'candidate replicas attached to their database', 120_000);
    for (const member of members) assert.deepEqual(ready(member), { status: 503, ready: false, code: '42P01', configured: true });
    return { deploymentId, members, targets: members.map(member => inner(['inspect', member, '--format', '{{.Id}}']).out) };
  };
  await env('DB_QUERY_FAIL', '1');
  {
    const current = await candidate(10);
    await until(async () => (await api(`/v1/services/${id}/deploys`)).find(row => row.id === current.deploymentId)?.status === 'failed', 'SQL failure rejects the whole candidate generation', 120_000);
    await cleared();
    assert.equal((await service(id)).runtimeId, old.runtimeId);
    assert.equal(ids.every(running), true); assert.equal(route(), 200);
    assert.equal(current.targets.every(absent), true);
    report({ case: 'replica-database-query-failure', allSqlFailuresHeld: true, previousGenerationStillServing: true, rejectedImmutableCandidatesRetired: true });
  }
  {
    const current = await candidate(60);
    inner(['exec', client, 'node', '-e', "fetch('http://127.0.0.1:8091/expect-stop').then(r=>r.text()).then(console.log)"]);
    const accepted = await api(`/v1/services/${id}/stop`, { method: 'POST', expectedStatus: 202 });
    await until(async () => {
      const command = (await api(`/v1/services/${id}/lifecycle`)).command;
      return command?.id === accepted.lifecycle.id && command.phase === 'completed';
    }, 'Stop supersedes SQL-unready deployment', 180_000);
    await until(() => current.targets.every(absent), 'cancelled immutable candidates retired');
    await pause(4000);
    assert.equal((await service(id)).status, 'stopped'); assert.equal(ids.some(running), false);
    assert.equal(route(), 404);
    assert.equal((await api(`/v1/services/${id}/deploys`)).find(row => row.id === current.deploymentId)?.status, 'cancelled');
    const records = JSON.parse(inner(['exec', client, 'node', '-e', "fetch('http://127.0.0.1:8091/snapshot').then(r=>r.text()).then(console.log)"]).out);
    assert.ok(records.length >= 50, 'The SQL fixture must observe traffic during deployment, rollback and Stop');
    assert.deepEqual(records.filter(row => row.error || row.status !== 200 && !(row.stopping && row.status === 404)), []);
    report({ case: 'replica-database-stop-during-readiness', explicitStopRetained: true, confirmedRouteRemoval: true,
      noAutomaticResurrection: true, cancelledImmutableCandidatesRetired: true, requests: records.length, unexpected502: 0 });
  }
  {
    await env('DB_QUERY_FAIL', '0');
    const deploymentId = (await api(`/v1/services/${id}/deploys`, { method: 'POST', body: {} })).deploymentId;
    await until(async () => {
      const job = (await api(`/v1/services/${id}/deploys`)).find(row => row.id === deploymentId);
      if (job?.status === 'failed' || job?.status === 'cancelled') throw new Error(`Post-Stop deployment ${job.status}`);
      return job?.status === 'running' && (await service(id)).status === 'running' && route() === 200;
    }, 'new deployment after completed Stop', 180_000);
    const runtime = await service(id);
    assert.equal(runtime.runtimeId, `${old.slug}-${deploymentId}`);
    assert.equal([runtime.runtimeId, `${runtime.runtimeId}-r2`].every(running), true);
    for (let n = 0; n < 30; n++) assert.equal(route(), 200);
    report({ case: 'replica-database-deploy-after-stop', newerDeploymentId: deploymentId, readyReplicas: 2, successfulRequests: 30 });
  }
}
