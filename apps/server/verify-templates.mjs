/**
 * Template verification harness: deploys EVERY registry template against the
 * live local instance and records health results. Run from apps/server:
 *
 *   node verify-templates.mjs [password] [baseUrl]
 *
 * DB-dependent templates get a managed database provisioned + attached first
 * (mirrors the wizard's auto-attach), so they should come up green too.
 */
const BASE = process.argv[3] ?? 'http://localhost:3000';
// Optional 4th arg: comma-separated template ids to verify (default: all).
const ONLY = process.argv[4] ? process.argv[4].split(',').map((s) => s.trim()) : null;
const EMAIL = 'admin@nine.dev';
const PASSWORD = process.argv[2] ?? process.env['ND_PASSWORD'] ?? '';

if (!PASSWORD) {
  console.error('usage: node verify-templates.mjs <admin-password> [baseUrl]');
  process.exit(1);
}

const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
};

// Access tokens live 15 minutes; transparently re-login when one expires.
let accessToken = (await api('/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})).tokens.accessToken;

const post = async (p, b) => {
  try {
    return await api(p, { method: 'POST', headers: authHeaders(), body: JSON.stringify(b ?? {}) });
  } catch (err) {
    if (String(err).includes('→ 401')) {
      accessToken = (await api('/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      })).tokens.accessToken;
      return api(p, { method: 'POST', headers: authHeaders(), body: JSON.stringify(b ?? {}) });
    }
    throw err;
  }
};
const get = async (p) => {
  try {
    return await api(p, { headers: authHeaders() });
  } catch (err) {
    if (String(err).includes('→ 401')) {
      accessToken = (await api('/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      })).tokens.accessToken;
      return api(p, { headers: authHeaders() });
    }
    throw err;
  }
};
function authHeaders() {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a database to be running (provisioned for DB-needing templates). */
async function waitForDb(dbId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await get(`/v1/databases/${dbId}`);
    if (d.status === 'running') return d;
    if (d.status === 'error' || Date.now() > deadline) throw new Error(`db status=${d.status}`);
    await sleep(3000);
  }
}

/** Wait for a deployment to reach a terminal state. */
async function waitForDeploy(svcId, depId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const deps = await get(`/v1/services/${svcId}/deploys`);
    const d = deps.find((x) => x.id === depId);
    last = d?.status ?? '?';
    if (d && !['queued', 'building', 'deploying'].includes(d.status)) return d;
    if (Date.now() > deadline) return { status: `timeout(${last})` };
    await sleep(4000);
  }
}

const templates = (await get('/v1/templates')).filter((t) => !ONLY || ONLY.includes(t.id));
console.log(`# ${templates.length} templates to verify against ${BASE}${ONLY ? ` (filtered: ${ONLY.join(',')})` : ''}\n`);

const results = [];
const START = Date.now();
let i = 0;
for (const summary of templates) {
  i++;
  const t = await get(`/v1/templates/${summary.id}`);
  const label = `${String(i).padStart(2)}/${templates.length} ${t.id}`;
  const t0 = Date.now();
  try {
    // Provision + attach the DB this template needs (wizard auto-attach path).
    let attachNote = '';
    if (t.dbEngine) {
      const db = await post('/v1/databases', { name: `${t.id}-db-${Date.now().toString(36).slice(-4)}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'), engine: t.dbEngine });
      await waitForDb(db.id, 180_000);
      // The one-click deploy endpoint creates its own service; attach after.
      const dep = await post(`/v1/templates/${t.id}/deploy`);
      await post(`/v1/services/${dep.serviceId}/attachments`, { databaseId: db.id });
      attachNote = ` (+${t.dbEngine} db attached)`;
      const d = await waitForDeploy(dep.serviceId, dep.deploymentId, 420_000);
      const mins = ((Date.now() - t0) / 60_000).toFixed(1);
      results.push({ id: t.id, ok: d.status === 'running', status: d.status, mins, note: attachNote });
      console.log(`${label}: ${d.status === 'running' ? 'OK ' : 'FAIL'} ${d.status} (${mins}m)${attachNote}`);
    } else {
      const dep = await post(`/v1/templates/${t.id}/deploy`);
      const d = await waitForDeploy(dep.serviceId, dep.deploymentId, 420_000);
      const mins = ((Date.now() - t0) / 60_000).toFixed(1);
      const gen = dep.generatedSecrets?.length ? ` [${dep.generatedSecrets.length} secrets generated]` : '';
      results.push({ id: t.id, ok: d.status === 'running', status: d.status, mins, note: gen });
      console.log(`${label}: ${d.status === 'running' ? 'OK ' : 'FAIL'} ${d.status} (${mins}m)${gen}`);
    }
  } catch (err) {
    const mins = ((Date.now() - t0) / 60_000).toFixed(1);
    results.push({ id: t.id, ok: false, status: 'error', mins, note: err.message.slice(0, 160) });
    console.log(`${label}: ERROR ${err.message.slice(0, 160)} (${mins}m)`);
  }
}

const ok = results.filter((r) => r.ok).length;
console.log(`\n# Summary: ${ok}/${results.length} running · total ${((Date.now() - START) / 60_000).toFixed(1)}m`);
console.log('\n| Template | Result | Time | Note |');
console.log('|---|---|---|---|');
for (const r of results.sort((a, b) => Number(a.ok) - Number(b.ok))) {
  console.log(`| ${r.id} | ${r.ok ? '✅ running' : `❌ ${r.status}`} | ${r.mins}m | ${r.note} |`);
}
