import assert from 'node:assert/strict';
import { manualWakeSampler } from './smoke-node-manual-wake.mjs';

/** Public setting/status + real plugin timers; no private idle admission or controller invocation. */
export async function smokeNodeAutomaticSleep({ api, inner, docker, panel, id, fixtureImage, ownerLabel, source, service, domain, until, pause, report, cleared, restartPanel, save }) {
  await cleared();
  const selected = await service(id), name = selected.runtimeId;
  const nodeId = inner(['inspect', name, '--format', '{{.Id}}']).out;
  const state = () => JSON.parse(inner(['inspect', nodeId, '--format', '{{json .State}}']).out);
  assert.equal(state().Running, true);
  const started = Date.now();
  await api(`/v1/services/${id}`, { method: 'PATCH', body: { sleepAfterMinutes: 5, healthTimeoutSeconds: 10 } });
  const status = () => api(`/v1/services/${id}/sleep`);
  const initial = await status(); assert.equal(initial.nodeControllerActive, true); assert.equal(initial.placement, 'node');
  assert.equal(initial.configured, true); assert.equal(initial.requiredMs, 300_000);
  await until(async () => (await status()).idleMs >= 60_000, 'public closed idle-window observation', 120_000);
  const control = inner(['run', '--rm', '--label', `ninedeploy.proof=${ownerLabel}`, '--network', 'ninedeploy', '--entrypoint', 'node', fixtureImage, '-e',
    `fetch('http://ninedeploy-proxy/',{headers:{host:${JSON.stringify(domain.hostname)}},signal:AbortSignal.timeout(1500)}).then(async r=>{if(r.status!==200||await r.text()!=='old')process.exit(1);else console.log('verified-application')}).catch(()=>process.exit(1))`]);
  assert.equal(control.out, 'verified-application');
  const lastServingAt = Date.now();
  await until(async () => (await status()).idleMs === 0, 'real serving request resets automatic idle coverage', 30_000);
  assert.equal(state().Running, true); assert.equal((await service(id)).asleepAt, null);
  // Fault affects readiness on the captured generation. Continuous visitor
  // requests start only once automatic admission and Stop are complete.
  inner(['exec', nodeId, 'node', '-e', "require('node:fs').writeFileSync('/tmp/nd-unready','1')"]);
  const asleep = await until(async () => {
    const current = await status();
    return current.phase === 'asleep' && (await service(id)).asleepAt ? current : false;
  }, 'public plugin genuine idle and automatic Stop', 480_000);
  assert.ok(Date.now() - lastServingAt >= 300_000 && asleep.idleMs >= 300_000, 'Public automatic sleep lacked genuine idle after the serving-request reset');
  assert.equal(state().Running, false);
  save('automatic-sleep-idle.json', { source, realPublicApi: true, privateFactoryAdmission: false,
    wallMs: Date.now() - started, idleAfterServingMs: Date.now() - lastServingAt, realTrafficReset: true,
    observedIdleMs: asleep.idleMs, immutableNodeId: nodeId, status: asleep });
  const client = `nd-auto-sleep-client-${id}`;
  inner(['run', '-d', '--name', client, '--label', `ninedeploy.proof=${ownerLabel}`, '--network', 'ninedeploy', '--entrypoint', 'node', fixtureImage, '-e', manualWakeSampler(domain.hostname)]);
  const call = path => JSON.parse(inner(['exec', client, 'node', '-e', `fetch('http://127.0.0.1:8091/${path}').then(r=>r.text()).then(console.log)`]).out);
  let completed = false;
  try {
    await until(() => inner(['exec', client, 'node', '-e', "fetch('http://127.0.0.1:8091/snapshot').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
      { allowFailure: true }).status === 0, 'automatic wake traffic observer', 15_000);
    await until(async () => (await status()).phase === 'held', 'automatic wake held on real failed HTTP readiness', 60_000);
    assert.ok((await service(id)).asleepAt); assert.equal(state().Running, true);
    const startedAt = state().StartedAt;
    const held = call('snapshot'); assert.ok(held.length >= 100 && held.every(row => row.waking), 'Failed readiness exposed the application or a proxy failure');
    const previousPanelStart = docker(['inspect', panel, '--format', '{{.State.StartedAt}}']).out;
    await restartPanel();
    assert.notEqual(docker(['inspect', panel, '--format', '{{.State.StartedAt}}']).out, previousPanelStart);
    await until(async () => (await status()).phase === 'held', 'normal restarted plugin recovers pending wake', 60_000);
    const recovered = call('snapshot'); assert.ok(recovered.length > held.length && recovered.every(row => row.waking));
    assert.equal(state().StartedAt, startedAt, 'Panel recovery restarted the acknowledged application');
    inner(['exec', nodeId, 'node', '-e', "require('node:fs').writeFileSync('/tmp/nd-unready','0')"]);
    await until(async () => !(await service(id)).asleepAt && (await status()).phase === 'observing', 'automatic retry confirms readiness and application routing', 90_000);
    await until(() => call('snapshot').filter(row => row.application).length >= 50, 'application traffic after recovered automatic wake', 15_000);
    await pause(1500);
    assert.equal(state().StartedAt, startedAt); assert.equal(state().Running, true);
    assert.equal(inner(['inspect', name, '--format', '{{.Id}}']).out, nodeId);
    const rows = call('finish'); save('automatic-sleep-traffic.json', rows);
    assert.ok(rows.length >= 100 && rows.every(row => !row.error && (row.application || row.waking)));
    assert.ok(rows.slice(-40).every(row => row.application));
    completed = true;
    report({ case: 'public-automatic-idle-stop-wake-recovery', source, privateFactoryAdmission: false, realPluginTimers: true,
      observedIdleMs: asleep.idleMs, realTrafficReset: true, immutableNodeId: nodeId, realFailedReadiness: true, panelRestartRecovered: true,
      stableAcknowledgedStart: true, requests: rows.length, wakingPages: rows.filter(row => row.waking).length,
      applicationResponses: rows.filter(row => row.application).length, unexpected502: 0 });
  } finally {
    if (!completed) { try { save('automatic-sleep-traffic.json', call('finish')); } catch { /* Preserve the original failure. */ } }
  }
}
