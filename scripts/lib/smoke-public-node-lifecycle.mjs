import assert from 'node:assert/strict';

/** Match the first agent supporting ordered lifecycle, including maintenance releases. */
export function nodeLifecycleDisabledRefusal(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const [major, minor, patch] = version.split('.').map(Number);
  const supported = major > 0 || minor > 18 || minor === 18 && patch >= 3;
  return supported ? { status: 403, code: 'node_feature_disabled' } : { status: 422, code: 'node_agent_outdated' };
}

/** Runs against the full production panel, worker, enrolled agent and isolated Docker daemon. */
export async function smokePublicNodeLifecycle({ api, inner, docker, panel, args, id, first, fixtureImage, service, domain, until, pause, report, cleared, updatePanelUrl }) {
  const latest = async () => (await api(`/v1/services/${id}/lifecycle`)).command;
  const disabledRefusal = nodeLifecycleDisabledRefusal((await api('/health')).version);
  const request = async action => {
    const result = await api(`/v1/services/${id}/${action}`, { method: 'POST', expectedStatus: 202 });
    assert.equal(result.pending, true); assert.equal(result.lifecycle.action, action);
    return result.lifecycle;
  };
  const completed = async command => until(async () => {
    const row = await latest(); assert.equal(row.id, command.id, 'Recovery must retain the original command');
    assert.notEqual(row.phase, 'superseded'); return row.phase === 'completed' && row;
  }, `completed ${command.action} #${command.id}`, 180_000);
  const runtime = (await service(id)).runtimeId;
  inner(['run', '-d', '--name', 'nd-lifecycle-client', '--network', 'ninedeploy', '--entrypoint', 'node', fixtureImage, '-e', 'setInterval(()=>{},1000)']);
  const names = [runtime, runtime + '-r2'];
  const ids = names.map(name => inner(['inspect', name, '--format', '{{.Id}}']).out);
  const running = target => inner(['inspect', target, '--format', '{{.State.Running}}']).out === 'true';
  const unready = value => {
    for (const name of names) inner(['exec', name, 'node', '-e', `require('node:fs').writeFileSync('/tmp/nd-unready',${JSON.stringify(value ? '1' : '0')})`]);
  };
  const routed = () => {
    const code = `const http=require('node:http');const q=http.request({hostname:'ninedeploy-proxy',path:'/',headers:{host:${JSON.stringify(domain.hostname)}}},r=>{r.resume();r.on('end',()=>console.log(r.statusCode))});q.setTimeout(2000,()=>q.destroy(Error('timeout')));q.on('error',e=>{console.error(e.message);process.exitCode=1});q.end();`;
    return Number(inner(['exec', 'nd-lifecycle-client', 'node', '-e', code]).out);
  };
  await cleared(); assert.equal(names.every(running), true);
  assert.equal(routed(), 200);
  {
    const command = await request('stop'); await completed(command);
    assert.equal((await service(id)).status, 'stopped'); assert.equal(ids.some(running), false);
    assert.equal(routed(), 404);
    report({ case: 'public-stop', accepted202: true, physicalReplicas: ids.length, confirmedRouteRemoval: true });
  }
  {
    await completed(await request('start')); unready(true); await completed(await request('stop'));
    const command = await request('start');
    await until(async () => (await latest()).phase === 'readiness' && ids.every(running), 'Start waiting for actual HTTP readiness');
    assert.equal((await service(id)).status, 'stopped'); assert.equal(routed(), 404);
    for (const name of names) assert.equal(inner(['exec', name, 'node', '-e', "fetch('http://127.0.0.1:8080/ready').then(r=>console.log(r.status))"]).out, '503');
    unready(false); await completed(command);
    assert.equal((await service(id)).status, 'running'); assert.equal(routed(), 200);
    assert.deepEqual(names.map(name => inner(['inspect', name, '--format', '{{.Id}}']).out), ids);
    report({ case: 'public-start-readiness', actualHttp503Held: true, runningAfterReadinessAndRouting: true, immutableIdsRetained: true });
  }
  {
    const spare = runtime + '-r3';
    const image = inner(['inspect', runtime, '--format', '{{.Image}}']).out;
    inner(['run', '-d', '--name', spare, '--network', 'ninedeploy', '--label', 'ninedeploy.managed=service', '--label', `ninedeploy.service=${id}`, '--label', `ninedeploy.deployment=${first}`, image]);
    const command = await request('restart'); await completed(command);
    assert.equal(ids.every(running), true); assert.equal(running(spare), false); assert.equal(routed(), 200);
    assert.deepEqual(names.map(name => inner(['inspect', name, '--format', '{{.Id}}']).out), ids);
    report({ case: 'public-restart', servingReplicas: ids.length, stoppedSpareCapacity: true, immutableIdsRetained: true });
  }
  {
    unready(true); await completed(await request('stop')); const old = await request('start');
    await until(async () => (await latest()).phase === 'readiness' && ids.every(running), 'interrupted Start readiness');
    const stop = await request('stop'); assert.ok(stop.id > old.id); await completed(stop); await pause(4000);
    assert.equal((await service(id)).status, 'stopped'); assert.equal(ids.some(running), false); assert.equal(routed(), 404);
    report({ case: 'public-stop-supersedes-unready-start', noLateRunningPublication: true, noAutomaticRevival: true });
    const next = await request('start');
    await until(() => ids.every(running), 'fresh Start effects'); unready(false); await completed(next);
  }
  {
    unready(true); await completed(await request('stop')); const command = await request('start');
    await until(async () => (await latest()).phase === 'readiness' && ids.every(running), 'crash during readiness');
    docker(['kill', panel]); docker(['start', panel]); updatePanelUrl();
    await until(async () => { try { return (await api('/health')).status === 'ok'; } catch { return false; } }, 'restarted panel health');
    assert.equal((await latest()).id, command.id); unready(false); await completed(command);
    assert.equal((await service(id)).status, 'running'); assert.equal(routed(), 200);
    report({ case: 'public-panel-crash-recovery', durableOriginalCommand: true, expiredLeaseRecovery: true, readinessRepeated: true });
  }
  {
    inner(['stop', 'ninedeploy-agent']);
    const command = await request('stop'); assert.equal((await service(id)).status, 'stopped');
    await until(async () => { const row = await latest(); return row.reason && !row.busy; }, 'offline Stop held');
    assert.equal(ids.every(running), true, 'No success may be inferred from an unreachable node');
    inner(['rm', 'ninedeploy-agent']);
    const disabled = [...args]; const slot = disabled.indexOf('NINEDEPLOY_AGENT_PROXY_TRAFFIC=on'); assert.ok(slot > 0);
    disabled.splice(slot - 1, 0, '-e', 'NINEDEPLOY_AGENT_CONTAINER_LIFECYCLE=off'); inner(disabled);
    await until(async () => { try { const result = await api(`/v1/services/${id}/start`, { method: 'POST', expectedStatus: disabledRefusal.status }); return result.error.code === disabledRefusal.code; } catch { return false; } }, 'owner-disabled Start refusal');
    assert.equal((await latest()).id, command.id);
    inner(['rm', '-f', 'ninedeploy-agent']); inner(args);
    await until(async () => { try { return (await api(`/v1/services/${id}/lifecycle/retry`, { method: 'POST', expectedStatus: 202 })).command.id === command.id; } catch { return false; } }, 'retry after node returns');
    await completed(command); assert.equal(ids.some(running), false); assert.equal(routed(), 404);
    report({ case: 'public-offline-and-owner-disabled', stopIntentRetained: true, noLegacyFallback: true, sameCommandRetry: true });
  }
  {
    await completed(await request('start'));
    await api(`/v1/services/${id}/env`, { method: 'POST', body: { key: 'NEEDS_READINESS', value: '1' } });
    const dep = (await api(`/v1/services/${id}/deploys`, { method: 'POST', body: {} })).deploymentId;
    const candidate = runtime.replace(/-\d+$/, '-' + dep), second = candidate + '-r2';
    await until(() => inner(['inspect', second, '--format', '{{.State.Running}}'], { allowFailure: true }).out === 'true', 'second deployment replica', 120_000);
    inner(['exec', candidate, 'node', '-e', "require('node:fs').writeFileSync('/tmp/nd-ready','ready')"]);
    assert.equal(inner(['exec', candidate, 'node', '-e', "fetch('http://127.0.0.1:8080/ready').then(r=>console.log(r.status))"]).out, '200');
    assert.equal(inner(['exec', second, 'node', '-e', "fetch('http://127.0.0.1:8080/ready').then(r=>console.log(r.status))"]).out, '503');
    await pause(6000);
    assert.equal((await service(id)).runtimeId, runtime, 'A ready primary must not promote an unready sibling');
    assert.equal(ids.every(running), true); assert.equal(routed(), 200);
    inner(['exec', second, 'node', '-e', "require('node:fs').writeFileSync('/tmp/nd-ready','ready')"]);
    await until(async () => (await service(id)).runtimeId === candidate && (await api(`/v1/services/${id}/deploys`)).find(row => row.id === dep)?.status === 'running', 'whole ready generation promoted', 180_000);
    await cleared();
    assert.equal(ids.some(target => inner(['inspect', target], { allowFailure: true }).status === 0), false, 'Previous immutable generation must be retired');
    assert.equal(routed(), 200);
    const images = [candidate, second].map(name => inner(['inspect', name, '--format', '{{.Image}}']).out);
    assert.equal(images[0], images[1]);
    report({ case: 'public-replica-redeploy-readiness', primaryReadySibling503Held: true, oneImmutableImage: true, previousRetiredAfterConfirmation: true });
  }
}
