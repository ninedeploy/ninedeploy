import assert from 'node:assert/strict';

/** Public authenticated wake + production worker; idle admission uses a private real-observation fixture. */
export async function smokeNodeManualWake({ api, inner, primary, docker, panel, id, fixtureImage, ownerLabel, source, service, domain, until, pause, report, cleared, save }) {
  await cleared();
  await api(`/v1/services/${id}`, { method: 'PATCH', body: { sleepAfterMinutes: 5, healthTimeoutSeconds: 10 } });
  const selected = await service(id), name = selected.runtimeId;
  const nodeId = inner(['inspect', name, '--format', '{{.Id}}']).out;
  // The normal API deployment is the healthy control. Persist a readiness fault
  // in the same immutable node container before its actual Stop/Start cycle.
  inner(['exec', name, 'node', '-e', "require('node:fs').writeFileSync('/tmp/nd-unready','1')"]);
  docker(['cp', 'scripts/fixtures/node-manual-wake-idle.mjs', `${panel}:/tmp/node-manual-wake-idle.mjs`]);
  const idle = JSON.parse(docker(['exec', '-e', 'GITHUB_ACTIONS=true', panel, 'node', '/tmp/node-manual-wake-idle.mjs', String(id)], { timeout: 480_000 }).out);
  assert.ok(idle.realIdle && idle.observedIdleMs >= 300_000 && idle.state === 'asleep');
  assert.ok(idle.immutableTargets.some(target => target.id === nodeId && target.name === name));
  assert.equal(inner(['inspect', nodeId, '--format', '{{.State.Running}}']).out, 'false');
  save('manual-wake-idle.json', idle);

  assert.notEqual(primary(['inspect', name], { allowFailure: true }).status, 0, 'Refuse an existing same-name panel container');
  const decoyId = primary(['create', '--name', name, '--label', `ninedeploy.proof=${ownerLabel}`, '--network', 'ninedeploy', '--entrypoint', 'node', fixtureImage, '-e',
    "require('node:http').createServer((q,r)=>r.end('panel-decoy')).listen(8080,'0.0.0.0')"]).out;
  const decoy = () => JSON.parse(primary(['inspect', decoyId, '--format', '{{json .State}}']).out);
  const original = decoy(); assert.equal(original.Running, false);
  const client = `nd-manual-wake-client-${id}`;
  inner(['run', '-d', '--name', client, '--label', `ninedeploy.proof=${ownerLabel}`, '--network', 'ninedeploy', '--entrypoint', 'node', fixtureImage, '-e', manualWakeSampler(domain.hostname)]);
  const call = path => JSON.parse(inner(['exec', client, 'node', '-e', `fetch('http://127.0.0.1:8091/${path}').then(r=>r.text()).then(console.log)`]).out);
  await until(() => inner(['exec', client, 'node', '-e', "fetch('http://127.0.0.1:8091/snapshot').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
    { allowFailure: true }).status === 0, 'independent manual-wake observer', 15_000);
  await until(() => { const rows = call('snapshot'); return rows.length >= 20 && rows.every(row => row.waking); }, 'verified waking-page baseline', 30_000);
  let completed = false, commandId;
  try {
    let accepted, requestError;
    try { accepted = await api(`/v1/services/${id}/wake`, { method: 'POST', expectedStatus: 202 }); } catch (error) { requestError = error; }
    // Test the harmful effect before any expected HTTP/result-shape assertion.
    const after = decoy();
    assert.equal(after.StartedAt, original.StartedAt, 'Manual node wake started the same-name panel container');
    assert.equal(after.Running, false, 'Manual node wake mutated the panel daemon');
    if (requestError) throw requestError;
    assert.equal(accepted.pending, true, 'Public wake claimed completion instead of durable acceptance');
    commandId = accepted.lifecycle?.id; assert.ok(Number.isSafeInteger(commandId));
    assert.equal(accepted.lifecycle.action, 'start'); assert.ok((await service(id)).asleepAt, 'Acceptance cleared asleep before readiness');
    const held = await until(async () => {
      const command = (await api(`/v1/services/${id}/lifecycle`)).command;
      return command?.id === commandId && command.phase === 'readiness' && command.reason ? command : false;
    }, 'real failed HTTP readiness behind the catcher', 45_000);
    const unready = call('snapshot'); assert.ok(unready.length >= 100 && unready.every(row => row.waking), 'Failed readiness exposed an application or proxy error');
    assert.equal(inner(['inspect', nodeId, '--format', '{{.State.Running}}']).out, 'true');
    inner(['exec', nodeId, 'node', '-e', "require('node:fs').writeFileSync('/tmp/nd-unready','0')"]);
    const retry = await api(`/v1/services/${id}/lifecycle/retry`, { method: 'POST', expectedStatus: 202 });
    assert.equal(retry.command.id, commandId, 'Retry changed the admitted command');
    await until(async () => (await api(`/v1/services/${id}/lifecycle`)).command?.phase === 'completed', 'public worker confirmed ready routing', 60_000);
    assert.equal((await service(id)).asleepAt, null); assert.equal((await service(id)).status, 'running');
    await until(() => call('snapshot').some(row => row.application), 'real application response after manual wake', 15_000);
    await pause(1500);
    assert.equal(decoy().StartedAt, original.StartedAt); assert.equal(decoy().Running, false);
    assert.equal(inner(['inspect', name, '--format', '{{.Id}}']).out, nodeId);
    const rows = call('finish'); save('manual-wake-traffic.json', rows);
    assert.ok(rows.length >= 100 && rows.every(row => !row.error && (row.application || row.waking)), 'Manual wake traffic had an unexpected response');
    assert.ok(rows.some(row => row.application) && rows.some(row => row.waking));
    completed = true;
    report({ case: 'public-manual-node-wake', realPublicApi: true, realWorker: true, privateRealIdleAdmission: true,
      observedIdleMs: idle.observedIdleMs, sameCommandRetry: true, commandId, heldPhase: held.phase,
      source, immutableNodeId: nodeId, panelDecoyId: decoyId, panelDecoyNeverStarted: true,
      requests: rows.length, wakingPages: rows.filter(row => row.waking).length, applicationResponses: rows.filter(row => row.application).length, unexpected502: 0 });
  } finally {
    if (!completed) {
      try { save('manual-wake-traffic.json', call('finish')); } catch { /* Preserve the original failure. */ }
      save('manual-wake-outcome.json', { passed: false, source, commandId, panelDecoyNeverStarted: decoy().StartedAt === original.StartedAt });
    }
  }
}

export function manualWakeSampler(hostname, { paused = false } = {}) {
  return `const http=require('node:http');const rows=[];let stopped=false,active,started=${!paused};
async function tick(){if(stopped)return;const at=Date.now();active=new Promise(resolve=>{let timer,done=false;
 const finish=row=>{if(!done){done=true;clearTimeout(timer);resolve(row)}};
 const q=http.get({hostname:'ninedeploy-proxy',path:'/',headers:{host:${JSON.stringify(hostname)}}},r=>{let body='',large=false;r.setEncoding('utf8');
 r.on('data',c=>{if(body.length+c.length>16384)large=true;if(!large)body+=c});r.on('end',()=>finish({at,status:r.statusCode,
 application:!large&&r.statusCode===200&&body==='old',waking:!large&&r.statusCode===503&&r.headers['retry-after']==='5'&&body.includes('Waking up')&&body.includes('http-equiv="refresh"')}));
 r.on('error',()=>finish({at,status:0,error:'RESPONSE_ERROR'}))});
 timer=setTimeout(()=>q.destroy(Object.assign(new Error('deadline'),{code:'PROBE_TIMEOUT'})),1500);
 q.on('error',e=>finish({at,status:0,error:e.code||'REQUEST_ERROR'}))});rows.push(await active);active=undefined;if(!stopped)setTimeout(tick,30)}
http.createServer(async(q,r)=>{if(q.url==='/start'&&!started){started=true;tick()}if(q.url==='/finish'){stopped=true;await active}r.end(JSON.stringify(rows))}).listen(8091,'127.0.0.1');if(started)tick();`;
}
