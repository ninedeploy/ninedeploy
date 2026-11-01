// Launch a packaged build and confirm the instance list rendered from the
// app's own scheme, then keep a sign-in across a restart: a stand-in panel on
// the loopback is added and opened, its page saves a refresh token through
// the bridge, the app quits and starts again, and the token comes back. With
// an OS credential store (DPAPI, Keychain) the token is sealed on disk; with
// none (a Linux runner without a keyring) nothing may be written.
// Uses only the Chromium debugging port (the packaged app has the Node
// inspector fused off) and Node's built-in fetch/WebSocket.
//   node scripts/smoke.mjs [path to the packaged executable]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { waitForLauncher } from './launcher-ready.mjs';

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

// The stand-in panel: enough of one for the launcher's /health probe and a page to load.
const panel = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '0.0.0-smoke' }));
  } else if (req.url === '/v1/auth/refresh') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{}');
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>stand-in panel</title><p>panel</p>');
  }
});
await new Promise((resolve) => panel.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${panel.address().port}`;

function cdp(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onerror = () => reject(new Error('debugging socket failed'));
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== 1) return;
      ws.close();
      if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.exception?.description ?? 'evaluation failed'));
      else resolve(msg.result);
    };
  });
}
const evaluate = async (wsUrl, expression) =>
  (await cdp(wsUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;

const launcherState = (page) => waitForLauncher(async () => JSON.parse(await evaluate(
  page.webSocketDebuggerUrl,
  'JSON.stringify({ form: !!document.querySelector("#add-form"), bridge: typeof window.launcher, node: typeof require, title: document.title })',
)));

async function target(match, what) {
  for (let i = 0; i < 60; i++) {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => []);
    const hit = list.find((t) => t.type === 'page' && match(t.url));
    if (hit) return hit;
    await sleep(500);
  }
  throw new Error(`${what} never loaded`);
}

/** The panel page once its preload has run (the target shows up before that). */
async function panelPage(what) {
  const page = await target((u) => u.startsWith(origin), what);
  for (let i = 0; i < 40; i++) {
    if ((await evaluate(page.webSocketDebuggerUrl, 'typeof window.ninedeployDesktop').catch(() => 'undefined')) === 'object') return page;
    await sleep(250);
  }
  throw new Error(`${what} has no desktop bridge`);
}

function launch() {
  return spawn(exe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], { stdio: ['ignore', 'inherit', 'inherit'] });
}

/** Quit the way a user does: closing the browser lets Chromium flush its state (the sealed key with it). */
async function quit(child) {
  const version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
  if (version?.webSocketDebuggerUrl) void cdp(version.webSocketDebuggerUrl, 'Browser.close').catch(() => undefined);
  for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await sleep(250);
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await sleep(1000);
}

const credentialsFile = path.join(userData, 'credentials.json');
let child = launch();
let failure = null;
try {
  const launcher = await target((u) => u === LAUNCHER, `the instance list (${LAUNCHER})`);
  const rendered = await launcherState(launcher);
  console.log(`desktop smoke ok: ${exe} rendered the instance list (${JSON.stringify(rendered)})`);

  const status = await evaluate(launcher.webSocketDebuggerUrl, 'window.launcher.status()');
  const added = await evaluate(launcher.webSocketDebuggerUrl, `window.launcher.add('smoke', ${JSON.stringify(origin)})`);
  if (!added?.ok) throw new Error(`adding the stand-in panel failed: ${JSON.stringify(added)}`);
  const id = added.instance.id;
  await evaluate(launcher.webSocketDebuggerUrl, `window.launcher.open(${JSON.stringify(id)})`);
  const page = await panelPage('the stand-in panel');
  const token = `nd-smoke-${Math.random().toString(36).slice(2)}${Date.now()}`;
  const saved = await evaluate(page.webSocketDebuggerUrl, `window.ninedeployDesktop.saveRefreshToken(${JSON.stringify(token)})`);
  if (saved !== status.persist) throw new Error(`saveRefreshToken answered ${saved} with persist=${status.persist} (${status.store})`);
  const onDisk = existsSync(credentialsFile) ? readFileSync(credentialsFile, 'utf8') : '';
  if (onDisk.includes(token)) throw new Error('the refresh token is on disk in plain text');
  if (!status.persist && onDisk.includes(id)) throw new Error('nothing may be written without an OS credential store');
  if (status.persist && !onDisk.includes(id)) throw new Error('the sealed token was not written');

  // A restart: the instance is still listed, and the token comes back only through the OS store.
  await quit(child);
  child = launch();
  const again = await target((u) => u === LAUNCHER, 'the instance list after a restart');
  await launcherState(again);
  await evaluate(again.webSocketDebuggerUrl, `window.launcher.open(${JSON.stringify(id)})`);
  const reopened = await panelPage('the stand-in panel after a restart');
  const loaded = await evaluate(reopened.webSocketDebuggerUrl, 'window.ninedeployDesktop.loadRefreshToken()');
  // ND_SMOKE_KEYCHAIN_UNREACHABLE: a store that seals but cannot keep its key
  // (the macOS runner's Keychain refuses the unsigned app). The sealed token
  // must then come back as nothing, never as garbage or the token itself.
  const unreachable = process.env.ND_SMOKE_KEYCHAIN_UNREACHABLE === '1';
  const expected = status.persist && !unreachable ? token : null;
  if (loaded !== expected) throw new Error(`after a restart loadRefreshToken answered ${JSON.stringify(loaded)}`);

  // Removing the instance deletes its sealed token.
  const removed = await evaluate(again.webSocketDebuggerUrl, `window.launcher.remove(${JSON.stringify(id)})`);
  const after = existsSync(credentialsFile) ? readFileSync(credentialsFile, 'utf8') : '';
  if (!removed?.ok || after.includes(id)) throw new Error('removing the instance left its sealed token behind');
  console.log(
    status.persist && unreachable
      ? `desktop sign-in fallback ok: ${status.store} was unreachable, the token was sealed (never plain text), did not come back after a restart and was deleted with its instance; keeping a sign-in through it is NOT verified here`
      : status.persist
      ? `desktop sign-in ok: a refresh token was sealed with ${status.store}, survived a restart and was deleted with its instance`
      : `desktop sign-in ok: without an OS credential store (${status.store}) nothing was written and nothing came back after a restart`,
  );
} catch (err) {
  failure = err;
} finally {
  await quit(child);
  panel.close();
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
