// Launch a packaged build and confirm the instance list rendered from the
// app's own scheme. Uses only the Chromium debugging port (the packaged app
// has the Node inspector fused off) and Node's built-in fetch/WebSocket.
//   node scripts/smoke.mjs [path to the packaged executable]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = {
  win32: ['release/win-unpacked/NineDeploy.exe'],
  darwin: ['release/mac-arm64/NineDeploy.app/Contents/MacOS/NineDeploy', 'release/mac/NineDeploy.app/Contents/MacOS/NineDeploy'],
  linux: ['release/linux-unpacked/ninedeploy-desktop'],
};
const exe = process.argv[2] ?? (CANDIDATES[process.platform] ?? []).find((p) => existsSync(p));
if (!exe || !existsSync(exe)) throw new Error(`no packaged executable found (${exe ?? process.platform})`);

const PORT = 9339;
const LAUNCHER = 'nd-app://launcher/index.html';
const userData = mkdtempSync(path.join(os.tmpdir(), 'nd-desktop-smoke-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(exe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], { stdio: ['ignore', 'inherit', 'inherit'] });

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onerror = () => reject(new Error('debugging socket failed'));
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== 1) return;
      ws.close();
      resolve(msg.result?.result?.value);
    };
  });
}

let failure = null;
try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => []);
    target = list.find((t) => t.url === LAUNCHER) ?? null;
  }
  if (!target) throw new Error(`the instance list never loaded from ${LAUNCHER}`);
  let rendered = null;
  for (let i = 0; i < 20 && !rendered?.form; i++) {
    rendered = await evaluate(
      target.webSocketDebuggerUrl,
      'JSON.stringify({ form: !!document.querySelector("#add-form"), bridge: typeof window.launcher, node: typeof require, title: document.title })',
    ).then((v) => JSON.parse(v));
    if (!rendered.form) await sleep(500);
  }
  if (!rendered?.form || rendered.bridge !== 'object' || rendered.node !== 'undefined') throw new Error(`unexpected launcher state ${JSON.stringify(rendered)}`);
  console.log(`desktop smoke ok: ${exe} rendered the instance list (${JSON.stringify(rendered)})`);
} catch (err) {
  failure = err;
} finally {
  child.kill();
  await sleep(1000);
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
