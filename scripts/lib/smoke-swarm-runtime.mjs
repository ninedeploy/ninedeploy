import assert from 'node:assert/strict';

export function swarmTrafficSampler(hostname) {
  return `const http=require('node:http');const rows=[];let stopped=false,active;
async function tick(){if(stopped)return;const at=Date.now();active=new Promise(resolve=>{let timer,done=false;
 const finish=row=>{if(!done){done=true;clearTimeout(timer);resolve(row)}};
 const q=http.get({hostname:'ninedeploy-proxy',headers:{host:${JSON.stringify(hostname)}}},r=>{let body='',large=false;r.setEncoding('utf8');
 r.on('data',c=>{if(body.length+c.length>16384)large=true;if(!large)body+=c});r.on('end',()=>{const label=!large&&body==='baked-one'?'one':!large&&body==='baked-two'?'two':null;finish({at,status:r.statusCode,label,application:r.statusCode===200&&label!==null})});
 r.on('error',()=>finish({at,status:0,application:false,error:'RESPONSE_ERROR'}))});
 timer=setTimeout(()=>q.destroy(new Error('deadline')),1500);q.on('error',()=>finish({at,status:0,application:false,error:'REQUEST_ERROR'}))});
 rows.push(await active);active=undefined;if(!stopped)setTimeout(tick,30)}
http.createServer(async(q,r)=>{if(q.url==='/finish'){stopped=true;await active}r.end(JSON.stringify(rows))}).listen(8091,'127.0.0.1');tick();`;
}

/** Single-manager real Swarm, pinned artifacts and normal restart recovery. */
export async function smokeSwarmRuntime({ api, primary, docker, panel, id, first, fixtureImage, ownerLabel, source,
  service, domain, until, pause, report, success, rows, log, env, cleared, repository, syncRepository, gitStats, repoUrl, managerAddr, restartPanel, save }) {
  await cleared();
  const original = await service(id), oldDockerId = primary(['inspect', original.runtimeId, '--format', '{{.Id}}']).out;
  assert.equal((await rows(id)).find(row => row.id === first).commitSha, repository.first);
  await api('/v1/swarm/init', { method: 'POST', body: { advertiseAddr: managerAddr, password: 'Readiness-fixture-only-2026!' } });
  const enabled = await api('/v1/swarm/settings', { method: 'PUT', body: { enabled: true, password: 'Readiness-fixture-only-2026!' } });
  assert.equal(enabled.enabled, true);
  const manager = primary(['info', '--format', '{{.Swarm.NodeID}}']).out; assert.match(manager, /^[a-z0-9]{25}$/);
  const clients = [];
  async function traffic(serviceId, hostname) {
    const name = `nd-swarm-client-${serviceId}`; clients.push(name);
    primary(['run', '-d', '--name', name, '--label', `ninedeploy.proof=${ownerLabel}`, '--network', 'ninedeploy', '--entrypoint', 'node', fixtureImage, '-e', swarmTrafficSampler(hostname)]);
    const read = path => JSON.parse(primary(['exec', name, 'node', '-e', `fetch('http://127.0.0.1:8091/${path}').then(r=>r.text()).then(console.log)`]).out);
    await until(() => primary(['exec', name, 'node', '-e', "fetch('http://127.0.0.1:8091/snapshot').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { allowFailure: true }).status === 0, 'Swarm traffic collector', 15_000);
    await until(() => read('snapshot').length >= 20, 'actual application traffic baseline', 15_000);
    assert.ok(read('snapshot').every(row => row.application && row.label === 'one'));
    return { read, name };
  }
  async function snapshot(serviceId, deploymentId) {
    const current = await service(serviceId), name = current.runtimeId;
    const native = JSON.parse(primary(['service', 'inspect', name, '--format', '{"id":{{json .ID}},"version":{{json .Version.Index}},"image":{{json .Spec.TaskTemplate.ContainerSpec.Image}},"service":{{json (index .Spec.Labels "ninedeploy.service")}},"deployment":{{json (index .Spec.Labels "ninedeploy.deployment")}}}']).out);
    assert.equal(native.service, String(serviceId)); assert.equal(native.deployment, String(deploymentId));
    const tasks = primary(['service', 'ps', '--no-trunc', '--filter', 'desired-state=running', '-q', name]).out.split('\n').filter(Boolean);
    assert.equal(tasks.length, 1);
    const task = JSON.parse(primary(['inspect', '--type', 'task', tasks[0], '--format', '{"id":{{json .ID}},"node":{{json .NodeID}},"state":{{json .Status.State}},"container":{{if .Status.ContainerStatus}}{{json .Status.ContainerStatus.ContainerID}}{{else}}null{{end}}}']).out);
    assert.equal(task.node, manager); assert.equal(task.state, 'running'); assert.match(task.container, /^[a-f0-9]{64}$/);
    const image = primary(['inspect', task.container, '--format', '{{.Image}}']).out; assert.match(image, /^sha256:[a-f0-9]{64}$/);
    assert.equal(primary(['inspect', task.container, '--format', '{{.State.Health.Status}}']).out, 'healthy');
    const network = JSON.parse(primary(['network', 'inspect', `nd-swarm-${current.slug}`, '--format', '{{json .}}']).out);
    assert.equal(network.Driver, 'overlay'); assert.equal(network.Options.encrypted, '');
    return { serviceId, deploymentId, nativeServiceId: native.id, nativeVersion: native.version, imageRef: native.image, imageId: image,
      taskId: task.id, containerId: task.container, managerNodeId: manager, encryptedOverlayId: network.Id };
  }
  const sourceTraffic = await traffic(id, domain.hostname); let completed = false, phase = 'migration';
  try {
    await api(`/v1/services/${id}/placement`, { method: 'PUT', body: { orchestrator: 'swarm' } });
    const one = (await api(`/v1/services/${id}/deploys`, { method: 'POST', body: {} })).deploymentId;
    await success(id, one);
    await until(async () => !(await api(`/v1/services/${id}/swarm/recovery`)).entry, 'initial native journal settlement', 180_000);
    const firstSwarm = await snapshot(id, one);
    const oldState = primary(['inspect', oldDockerId, '--format', '{{.State.Running}}'], { allowFailure: true });
    assert.ok(oldState.status !== 0 || oldState.out === 'false', 'Docker-to-Swarm left the captured old runtime serving');
    const release = await api(`/v1/services/${id}/deploys/${one}/release`); assert.equal(release.available, true); assert.equal(release.mode, 'recorded-docker');
    report({ case: 'real-swarm-source-artifact', source, commit: repository.first, ...firstSwarm, previousDockerRetired: true });
    phase = 'promotion'; const secondCommit = repository.advance(); await syncRepository(); assert.notEqual(secondCommit, repository.first);
    const beforePromotionRequests = gitStats().requests;
    const created = await api('/v1/services', { method: 'POST', body: { name: 'Owned Swarm artifact target', type: 'docker', repoUrl, branch: 'main', port: 8080 } });
    const target = created.id ?? created.service?.id;
    await api(`/v1/services/${target}`, { method: 'PATCH', body: { healthCheck: 'command', healthCommand: "node -e \"const q=require('node:http').get('http://127.0.0.1:8080/ready',r=>process.exit(r.statusCode===200?0:1));q.on('error',()=>process.exit(1))\"", healthTimeoutSeconds: 180 } });
    await api(`/v1/services/${target}/placement`, { method: 'PUT', body: { orchestrator: 'swarm' } });
    const promotion = await api(`/v1/services/${id}/promote`, { method: 'POST', body: { targetServiceId: target, sourceDeploymentId: one, mode: 'artifact' } });
    assert.ok(promotion.deploymentId); await success(target, promotion.deploymentId);
    await until(async () => !(await api(`/v1/services/${target}/swarm/recovery`)).entry, 'promoted native journal settlement', 180_000);
    const promoted = await snapshot(target, promotion.deploymentId); assert.equal(promoted.imageId, firstSwarm.imageId);
    assert.equal((await rows(target)).find(row => row.id === promotion.deploymentId).commitSha, repository.first);
    assert.match(await log(target, promotion.deploymentId), /Recorded artifact.*skipping checkout/);
    assert.equal(gitStats().requests, beforePromotionRequests, 'Artifact promotion fetched source instead of using the recorded image');
    const targetDomain = (await api(`/v1/services/${target}/domains`))[0]; const targetTraffic = await traffic(target, targetDomain.hostname);
    report({ case: 'real-swarm-artifact-promotion', source, sourceCommit: repository.first, repositoryHead: secondCommit, noGitFetch: true, ...promoted });
    phase = 'candidate'; await env('NEEDS_READINESS', '1');
    const candidate = (await api(`/v1/services/${id}/deploys`, { method: 'POST', body: {} })).deploymentId;
    const candidates = () => primary(['ps', '-q', '--no-trunc', '--filter', `label=com.docker.swarm.service.id=${firstSwarm.nativeServiceId}`]).out.split('\n').filter(Boolean)
      .filter(container => primary(['inspect', container, '--format', '{{.Image}}']).out !== firstSwarm.imageId);
    await until(async () => {
      const row = (await api(`/v1/services/${id}/swarm/recovery`)).entry;
      return row?.deploymentId === candidate && row.busy && candidates().length ? row : false;
    }, 'native update journal and unready task before restart', 180_000);
    assert.ok(sourceTraffic.read('snapshot').every(row => row.application && row.label === 'one'), 'An unready native task received serving traffic');
    const beforeRestart = candidates(); assert.ok(beforeRestart.length);
    const candidateImageId = primary(['inspect', beforeRestart[0], '--format', '{{.Image}}']).out;
    assert.ok(beforeRestart.every(container => primary(['inspect', container, '--format', '{{.Image}}']).out === candidateImageId));
    const beforeRestartRequests = gitStats().requests;
    phase = 'restart'; const panelBefore = docker(['inspect', panel, '--format', '{{.State.StartedAt}}']).out;
    await restartPanel(); const panelAfter = docker(['inspect', panel, '--format', '{{.State.StartedAt}}']).out;
    assert.notEqual(panelAfter, panelBefore);
    const held = (await api(`/v1/services/${id}/swarm/recovery`)).entry;
    assert.equal(held?.deploymentId, candidate, 'Panel restart lost the native update journal');
    const unready = candidates(); assert.ok(unready.length, 'The captured native candidate disappeared during panel restart');
    for (const container of unready) primary(['exec', container, 'node', '-e', "require('node:fs').writeFileSync('/tmp/nd-ready','1')"]);
    await until(async () => {
      const deployment = (await rows(id)).find(row => row.id === candidate);
      if (deployment?.status === 'failed') throw new Error('Original native candidate failed instead of recovering');
      return deployment?.status === 'running' && !(await api(`/v1/services/${id}/swarm/recovery`)).entry;
    }, 'same deployment recovered without a replacement build', 240_000);
    const recovered = await snapshot(id, candidate); assert.notEqual(recovered.imageId, firstSwarm.imageId);
    assert.equal(recovered.imageId, candidateImageId); assert.equal(recovered.nativeServiceId, firstSwarm.nativeServiceId);
    assert.equal(gitStats().requests, beforeRestartRequests, 'Swarm recovery fetched source again');
    assert.equal((await rows(id)).find(row => row.id === candidate).commitSha, secondCommit);
    const activity = await until(async () => (await api(`/v1/activity?serviceId=${id}&action=deploy.success`)).entries.find(entry => entry.meta?.deploymentId === candidate && entry.meta?.recoveredAfterRestart), 'persisted recovered native update outcome', 15_000);
    assert.ok(activity);
    await until(() => sourceTraffic.read('snapshot').some(row => row.label === 'two'), 'recovered second artifact serves', 15_000);
    report({ case: 'real-swarm-panel-restart-recovery', source, originalDeploymentId: candidate, panelBefore, panelAfter, candidateImageId, noGitFetch: true, ...recovered });
    phase = 'rollback'; await env('NEEDS_READINESS', '0');
    const rollback = (await api(`/v1/services/${id}/deploys/${one}/rollback`, { method: 'POST' })).deploymentId;
    await success(id, rollback);
    await until(async () => !(await api(`/v1/services/${id}/swarm/recovery`)).entry, 'rollback native journal settlement', 180_000);
    const restored = await snapshot(id, rollback); assert.equal(restored.imageId, firstSwarm.imageId);
    assert.equal((await rows(id)).find(row => row.id === rollback).commitSha, repository.first);
    assert.match(await log(id, rollback), /Recorded artifact.*skipping checkout/);
    assert.equal(gitStats().requests, beforeRestartRequests, 'Recorded rollback fetched source again');
    assert.equal(restored.nativeServiceId, firstSwarm.nativeServiceId);
    await pause(2000);
    const sourceRows = sourceTraffic.read('finish'), targetRows = targetTraffic.read('finish');
    save('swarm-source-traffic.json', sourceRows); save('swarm-target-traffic.json', targetRows);
    assert.ok(sourceRows.length >= 100 && sourceRows.every(row => row.application && !row.error));
    assert.ok(targetRows.length >= 20 && targetRows.every(row => row.application && row.label === 'one' && !row.error));
    assert.ok(sourceRows.some(row => row.label === 'two')); assert.ok(sourceRows.slice(-40).every(row => row.label === 'one'));
    completed = true;
    report({ case: 'real-swarm-recorded-rollback', source, sourceCommit: repository.first, repositoryHead: secondCommit, ...restored,
      requests: sourceRows.length + targetRows.length, sourceRequests: sourceRows.length, targetRequests: targetRows.length, unexpected502: 0 });
  } finally {
    if (!completed) {
      const traces = [];
      for (const name of clients) {
        const result = primary(['exec', name, 'node', '-e', "fetch('http://127.0.0.1:8091/finish').then(r=>r.text()).then(console.log)"], { allowFailure: true });
        if (result.status === 0) { try { traces.push({ client: name, rows: JSON.parse(result.out) }); } catch { /* Keep the first failure. */ } }
      }
      save('swarm-failure-traffic.json', traces);
      try {
        const current = await service(id), recovery = (await api(`/v1/services/${id}/swarm/recovery`)).entry;
        save('swarm-failure-state.json', { source, phase, serviceStatus: current.status, runtimeId: current.runtimeId,
          recovery: recovery ? { id: recovery.id, deploymentId: recovery.deploymentId, phase: recovery.phase, busy: recovery.busy, interrupted: recovery.interrupted, attempts: recovery.attempts } : null });
      } catch { /* Diagnostics must not conceal the original failure. */ }
    }
  }
}
