import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { manualWakeSampler } from './smoke-node-manual-wake.mjs';

/** Real private sleep admission, sealed transport loss and production restoration. */
export async function smokeNodeSleepRestoration({ api, inner, docker, panel, id, fixtureImage, ownerLabel, source, service, domain, until, pause, report, cleared, save }) {
  await cleared();
  await api(`/v1/services/${id}`, { method: 'PATCH', body: { sleepAfterMinutes: 5 } });
  const selected = await service(id), name = selected.runtimeId;
  const nodeId = inner(['inspect', name, '--format', '{{.Id}}']).out;
  const before = JSON.parse(inner(['inspect', nodeId, '--format', '{{json .State}}']).out);
  assert.equal(before.Running, true);
  const client = `nd-sleep-restore-client-${id}`;
  inner(['run', '-d', '--name', client, '--label', `ninedeploy.proof=${ownerLabel}`, '--network', 'ninedeploy', '--entrypoint', 'node', fixtureImage, '-e', manualWakeSampler(domain.hostname, { paused: true })]);
  const call = path => JSON.parse(inner(['exec', client, 'node', '-e', `fetch('http://127.0.0.1:8091/${path}').then(r=>r.text()).then(console.log)`]).out);
  await until(() => inner(['exec', client, 'node', '-e', "fetch('http://127.0.0.1:8091/snapshot').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
    { allowFailure: true }).status === 0, 'paused restoration observer', 15_000);
  assert.deepEqual(call('snapshot'), []);
  docker(['cp', 'scripts/fixtures/node-sleep-restoration.mjs', `${panel}:/tmp/node-sleep-restoration.mjs`]);
  docker(['cp', 'scripts/lib/smoke-sealed-routing-fault.mjs', `${panel}:/tmp/smoke-sealed-routing-fault.mjs`]);
  const child = spawn('docker', ['exec', '-e', 'GITHUB_ACTIONS=true', panel, 'node', '/tmp/node-sleep-restoration.mjs', String(id)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', diagnostics = '', terminal = false, completed = false;
  child.stdout.on('data', bytes => { output += bytes; if (output.length > 64_000) child.kill(); });
  child.stderr.on('data', bytes => { diagnostics += bytes; if (diagnostics.length > 64_000) child.kill(); });
  const done = new Promise(resolve => {
    child.once('error', () => { diagnostics += 'Owned Docker exec could not start'; terminal = true; resolve(-1); });
    child.once('close', code => { terminal = true; resolve(code); });
  });
  const deadline = setTimeout(() => child.kill(), 480_000);
  try {
    await until(() => {
      assert.equal(terminal, false, `Real restoration fixture exited before idle handshake: ${diagnostics.slice(-2000)}`);
      return docker(['exec', panel, 'test', '-f', `/tmp/nd-sleep-restoration-${id}.ready`], { allowFailure: true }).status === 0;
    }, 'genuine five-minute idle before restoration', 450_000);
    call('start');
    docker(['exec', panel, 'node', '-e', `require('node:fs').writeFileSync('/tmp/nd-sleep-restoration-${id}.go','go')`]);
    assert.equal(await done, 0, `Restoration fixture failed: ${diagnostics.slice(-2000)}`);
    const receipt = JSON.parse(output); save('sleep-restoration-receipt.json', receipt);
    assert.ok(receipt.realIdle && receipt.observedIdleMs >= 300_000 && receipt.loadedRoutingAckDropped && receipt.ordinaryWriterConfirmed);
    assert.ok(receipt.immutableTargets.some(target => target.id === nodeId && target.name === name));
    assert.equal(receipt.state, 'aborted'); assert.equal(receipt.fallbackRouting, false); assert.equal(receipt.noRuntimeMutations, true);
    await until(() => call('snapshot').filter(row => row.application).length >= 50, 'healthy application after restoration and ordinary writer', 15_000);
    await pause(1500);
    const after = JSON.parse(inner(['inspect', nodeId, '--format', '{{json .State}}']).out);
    assert.equal(after.StartedAt, before.StartedAt, 'Restoration restarted the application');
    assert.equal(after.FinishedAt, before.FinishedAt, 'Restoration stopped the application'); assert.equal(after.Running, true);
    assert.equal((await service(id)).asleepAt, null);
    const rows = call('finish'); save('sleep-restoration-traffic.json', rows);
    assert.ok(rows.length >= 50 && rows.every(row => !row.error && (row.application || row.waking)), 'Pre-Stop restoration exposed an unexpected proxy response');
    assert.ok(rows.filter(row => row.waking).length >= 20, 'The real loaded fallback was not observed during the lost acknowledgement');
    assert.ok(rows.slice(-40).every(row => row.application), 'Restored route did not remain on the application');
    completed = true;
    report({ case: 'lost-pre-stop-routing-ack-restores-application', source, realSealedAgent: true, privateRealIdleAdmission: true,
      immutableNodeId: nodeId, observedIdleMs: receipt.observedIdleMs, loadedRoutingAckDropped: true,
      unchangedRuntimeStartAndFinish: true, ordinaryWriterConfirmed: true, requests: rows.length,
      wakingPages: rows.filter(row => row.waking).length, applicationResponses: rows.filter(row => row.application).length, unexpected502: 0 });
  } finally {
    clearTimeout(deadline);
    if (!terminal) { child.kill(); await done; }
    if (!completed) {
      try { save('sleep-restoration-traffic.json', call('finish')); } catch { /* Keep the original failure. */ }
    }
  }
}
