// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This fixture runs in its owned hosted container, outside Turbo.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, renameSync } from 'node:fs';
import http from 'node:http';
import { buildAgentApp } from '/app/apps/server/dist/agentApp.js';
import { agentRoutes } from '/app/apps/server/dist/agent.js';
import { seal, open } from '/app/apps/server/dist/lib/agentSeal.js';
import { sha256 } from '/app/apps/server/dist/lib/crypto.js';
import { withRoutingAck, confirmProxyRouting, routingProbeArgs } from '/app/apps/server/dist/lib/proxyRoutingAck.js';
import { nodeServingTraffic } from '/app/apps/server/dist/lib/nodeServingTraffic.js';
import { confirmServingTrafficRouting } from '/proof/serving-traffic-routing.mjs';

const input = JSON.parse(process.env.PROOF_INPUT), exec = promisify(execFile);
const token = randomBytes(32).toString('hex'), hash = sha256(token), cases = [], outcomes = [];
const app = await buildAgentApp();
await app.register(agentRoutes, { tokenHash: hash, nonceFile: '/tmp/serving-traffic-nonces' });
await app.listen({ host: '127.0.0.1', port: 0 });
const url = `http://127.0.0.1:${app.server.address().port}/agent/exec`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const confirm = (routes, proxyId) => confirmServingTrafficRouting(routes, proxyId, { confirmRouting: confirmProxyRouting, probeArgs: routingProbeArgs, execDocker: exec });
async function rpc(action, params, { plain = false } = {}) {
  const nonce = randomBytes(16).toString('hex'), payload = { op: action === 'capabilities' ? 'agent.ping' : `proxy.servingTraffic.${action}`, params, nonce };
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(plain ? { 'x-agent-token': token } : {}) },
    body: JSON.stringify(plain ? payload : { sealed: seal(hash, payload) }), signal: AbortSignal.timeout(20_000) });
  const raw = await response.json();
  if (response.status !== 200) throw Error(raw.error?.message ?? `Agent HTTP ${response.status}`);
  assert.ok(!plain && raw.sealed, 'successful observations must be sealed');
  const value = open(hash, raw.sealed);
  assert.equal(value.nonce, nonce); assert.equal(value.exitCode, 0);
  const prefix = action === 'capabilities' ? 'ND-AGENT ' : 'ND-SERVING-TRAFFIC ';
  const frames = value.lines.filter(line => line.startsWith(prefix));
  assert.equal(frames.length, 1);
  return JSON.parse(frames[0].slice(prefix.length));
}
function request(host = 'serving.invalid') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'ninedeploy-proxy', port: 80, path: '/', headers: { host } }, res => {
      let body = ''; res.on('data', value => body += value);
      res.on('end', () => { const row = { status: res.statusCode, body, host }; outcomes.push(row); resolve(row); });
    });
    req.setTimeout(2000, () => req.destroy(Error('request deadline'))); req.on('error', reject); req.end();
  });
}
const fresh = () => ({ ...input, requestId: randomBytes(16).toString('hex') });
async function rejectedWindow(change) {
  const opened = (await rpc('open', fresh())).snapshot;
  await change(opened);
  const reply = await rpc('sample', { windowIds: [opened.windowId] });
  assert.equal(reply.items.length, 1); assert.equal(reply.items[0].ok, false);
  assert.equal(nodeServingTraffic.activeCount(), 0);
  await rpc('close', { windowId: opened.windowId });
}
let complete = false;
try {
  assert.ok((await rpc('capabilities', {})).caps.includes('proxy.servingTraffic'));
  cases.push({ name: 'sealed-capability-owner-opt-in', passed: true });
  await assert.rejects(rpc('open', fresh(), { plain: true }), /sealed/);
  cases.push({ name: 'plaintext-refused', passed: true });
  const unrouted = 'http: {}';
  try {
    writeFileSync('/proof/next.yml', withRoutingAck(unrouted)); renameSync('/proof/next.yml', '/proof/dynamic.yml');
    await confirm(unrouted, process.env.PROOF_PROXY_ID);
    await assert.rejects(rpc('open', { ...fresh(), routingConfig: unrouted }), /unavailable/);
    assert.equal(nodeServingTraffic.activeCount(), 0);
    cases.push({ name: 'unrouted-serving-generation-held', passed: true });
  } finally {
    writeFileSync('/proof/next.yml', withRoutingAck(input.routingConfig)); renameSync('/proof/next.yml', '/proof/dynamic.yml');
    await confirm(input.routingConfig, process.env.PROOF_PROXY_ID);
  }
  const opened = (await rpc('open', fresh())).snapshot;
  for (let i = 0; i < 20; i++) assert.equal((await request()).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await request('unrelated.invalid')).status, 200);
  await pause(1100);
  const final = (await rpc('finish', { windowId: opened.windowId })).snapshot;
  assert.equal(final.complete, true); assert.equal(final.observed, final.expected);
  assert.equal(final.serving.requests, 20); assert.equal(final.serving.errors, 0);
  assert.ok(final.observed >= 25); assert.equal(final.purpose, 'autoscale');
  assert.ok(!('canary' in final) && !('step' in final) && !('stable' in final));
  assert.ok(input.serving.every(target => outcomes.some(row => row.host === 'serving.invalid' && row.body === target.id.slice(0, 12))));
  assert.deepEqual((await rpc('finish', { windowId: opened.windowId })).snapshot, final);
  cases.push({ name: 'serving-generation-and-unrelated-traffic', passed: true, snapshot: final, bothImmutableReplicasServed: true });
  const idle = (await rpc('open', fresh())).snapshot;
  await pause(1100);
  const zero = (await rpc('finish', { windowId: idle.windowId })).snapshot;
  assert.equal(zero.complete, true); assert.equal(zero.serving.requests, 0);
  cases.push({ name: 'verified-zero-serving-traffic', passed: true, snapshot: zero });
  await rejectedWindow(async opened => {
    const metadata = JSON.parse((await exec('docker', ['inspect', opened.proxyId], { timeout: 10_000 })).stdout)[0];
    assert.equal(metadata.Config.Labels['ninedeploy.proof'], process.env.PROOF_OWNER);
    await exec('docker', ['restart', opened.proxyId], { timeout: 30_000 });
  });
  cases.push({ name: 'proxy-restart-held', passed: true });
  await confirm(input.routingConfig, opened.proxyId);
  const changed = input.routingConfig + '\n# next generation\n';
  try {
    await rejectedWindow(async () => {
      writeFileSync('/proof/next.yml', withRoutingAck(changed)); renameSync('/proof/next.yml', '/proof/dynamic.yml');
      await confirm(changed, opened.proxyId);
    });
    cases.push({ name: 'routing-generation-change-held', passed: true });
  } finally {
    writeFileSync('/proof/next.yml', withRoutingAck(input.routingConfig)); renameSync('/proof/next.yml', '/proof/dynamic.yml');
    await confirm(input.routingConfig, opened.proxyId);
  }
  const replica = input.serving[1];
  try {
    await rejectedWindow(async () => {
      const metadata = JSON.parse((await exec('docker', ['inspect', replica.id], { timeout: 10_000 })).stdout)[0];
      assert.equal(metadata.Config.Labels['ninedeploy.proof'], process.env.PROOF_OWNER);
      await exec('docker', ['stop', replica.id], { timeout: 20_000 });
    });
    cases.push({ name: 'stopped-immutable-replica-held', passed: true });
  } finally { await exec('docker', ['start', replica.id], { timeout: 20_000 }); }
  process.env.NINEDEPLOY_AGENT_PROXY_TRAFFIC = 'off';
  assert.ok(!(await rpc('capabilities', {})).caps.includes('proxy.servingTraffic'));
  await assert.rejects(rpc('open', fresh()), /owner|opted in/);
  cases.push({ name: 'owner-disabled-held', passed: true });
  assert.equal(nodeServingTraffic.activeCount(), 0);
  complete = true;
} finally {
  nodeServingTraffic.closeAll();
  writeFileSync('/proof/agent-result.json', JSON.stringify({ complete, realSealedHttp: true, cases, outcomes, activeWindows: nodeServingTraffic.activeCount() }, null, 2));
  await app.close();
}
