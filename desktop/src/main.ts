import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  net,
  protocol,
  safeStorage,
  type Session,
  session,
  shell,
} from 'electron';
import { type Cipher, CredentialVault } from './credentials.js';
import { type Instance, InstanceStore, normalizeInstanceUrl } from './instances.js';
import { probeInstance, revokeDesktopSession } from './panelApi.js';
import { NavigationGuard, permissionAllowed, sameOrigin, trustedPanelSender, windowOpenDecision } from './policy.js';

export const APP_ID = 'net.ninedeploy.desktop';

/**
 * The instance list is served from a private scheme, not file://: the
 * GrantFileProtocolExtraPrivileges fuse is off, so file:// pages get no more
 * than a browser would give them, and the scheme answers only these files.
 */
const APP_SCHEME = 'nd-app';
const LAUNCHER_URL = `${APP_SCHEME}://launcher/index.html`;
const LAUNCHER_DIR = path.join(__dirname, 'launcher');
const LAUNCHER_FILES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'launcher.js': 'text/javascript; charset=utf-8',
  'launcher.css': 'text/css; charset=utf-8',
};

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);

function serveLauncherFile(request: Request): Response {
  const url = new URL(request.url);
  const name = url.pathname.replace(/^\/+/, '');
  const type = url.host === 'launcher' && Object.hasOwn(LAUNCHER_FILES, name) ? LAUNCHER_FILES[name] : undefined;
  if (!type) return new Response('Not found', { status: 404 });
  return new Response(readFileSync(path.join(LAUNCHER_DIR, name)), { headers: { 'content-type': type } });
}

interface PanelWindow {
  instance: Instance;
  window: BrowserWindow;
}

/** Keyed by the window's webContents id: that is what an IPC event names. */
const panels = new Map<number, PanelWindow>();
let launcher: BrowserWindow | null = null;
let store: InstanceStore;
let vault: CredentialVault;

const safeStorageCipher: Cipher = {
  available: () =>
    safeStorage.isEncryptionAvailable() &&
    // basic_text is Chromium's fallback with a hard-coded key: not an OS store.
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (sealed) => safeStorage.decryptString(sealed),
};

function credentialStoreName(): string {
  if (process.platform === 'win32') return 'Windows Data Protection (DPAPI)';
  if (process.platform === 'darwin') return 'the macOS Keychain';
  return `the desktop keyring (${safeStorage.getSelectedStorageBackend()})`;
}

function partitionFor(instance: Instance): string {
  return `persist:instance-${instance.id}`;
}

const hardened = new WeakSet<Session>();

/** Every panel gets its own cookie/storage partition, refusing all but two harmless permissions. */
function hardenSession(ses: Session, origin: string): void {
  if (hardened.has(ses)) return;
  hardened.add(ses);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permissionAllowed(permission, details.requestingUrl, origin));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin, origin));
  ses.setDevicePermissionHandler(() => false);
  // Exports and backups download from the panel; nothing else (an identity
  // provider's page during SSO) may start a save.
  ses.on('will-download', (event, _item, contents) => {
    if (!contents || !sameOrigin(contents.getURL(), origin)) event.preventDefault();
  });
}

/** The instance list's own session asks for nothing, so it is granted nothing. */
function hardenLauncherSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
}

function panelEntry(event: IpcMainInvokeEvent): PanelWindow {
  const entry = panels.get(event.sender.id);
  const frame = event.senderFrame;
  if (!entry || !frame || !trustedPanelSender(frame.url, frame === event.sender.mainFrame, entry.instance.origin)) {
    throw new Error('Refused: not the panel window of this instance.');
  }
  return entry;
}

function assertLauncher(event: IpcMainInvokeEvent): void {
  if (!launcher || event.sender !== launcher.webContents || event.senderFrame?.url !== LAUNCHER_URL) {
    throw new Error('Refused: not the instance list.');
  }
}

function openPanel(instance: Instance): void {
  const open = [...panels.values()].find((p) => p.instance.id === instance.id);
  if (open) {
    if (open.window.isMinimized()) open.window.restore();
    open.window.focus();
    return;
  }
  const partition = partitionFor(instance);
  hardenSession(session.fromPartition(partition), instance.origin);
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 480,
    minHeight: 400,
    title: instance.name,
    show: false,
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'preload-panel.cjs'),
      additionalArguments: [`--nd-instance-origin=${instance.origin}`],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });
  const contents = window.webContents;
  const id = contents.id;
  panels.set(id, { instance, window });
  const guard = new NavigationGuard(instance.origin);

  const apply = (event: { preventDefault(): void }, url: string, kind: 'navigate' | 'redirect'): void => {
    const decision = guard.decide(url, kind, contents.getURL());
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'external') void shell.openExternal(url);
  };
  contents.on('will-navigate', (event) => {
    if (event.isMainFrame) apply(event, event.url, 'navigate');
  });
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame) apply(event, event.url, 'redirect');
  });
  contents.on('did-navigate', (_event, url) => {
    guard.arrived(url);
    const host = URL.canParse(url) ? new URL(url).host : '';
    window.setTitle(new URL(instance.origin).host === host ? instance.name : `${instance.name} — sign-in at ${host}`);
  });
  contents.on('page-title-updated', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (windowOpenDecision(url) === 'external') void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => panels.delete(id));
  store.markOpened(instance.id);
  void window.loadURL(`${instance.origin}/`);
}

function showLauncher(): void {
  if (launcher) {
    if (launcher.isMinimized()) launcher.restore();
    launcher.focus();
    return;
  }
  launcher = new BrowserWindow({
    width: 620,
    height: 680,
    minWidth: 420,
    minHeight: 480,
    title: 'NineDeploy',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-launcher.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });
  launcher.webContents.on('will-navigate', (event) => event.preventDefault());
  launcher.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  launcher.once('ready-to-show', () => launcher?.show());
  launcher.on('closed', () => {
    launcher = null;
  });
  void launcher.loadURL(LAUNCHER_URL);
}

function registerIpc(): void {
  ipcMain.handle('launcher:status', (event) => {
    assertLauncher(event);
    return { persist: vault.canPersist(), store: credentialStoreName(), platform: process.platform };
  });
  ipcMain.handle('launcher:list', (event) => {
    assertLauncher(event);
    return store.list().map((i) => ({ ...i, open: [...panels.values()].some((p) => p.instance.id === i.id) }));
  });
  ipcMain.handle('launcher:add', async (event, name: unknown, address: unknown) => {
    assertLauncher(event);
    const normalized = normalizeInstanceUrl(String(address ?? ''));
    if (!normalized.ok) return { ok: false, reason: normalized.reason };
    const probe = await probeInstance(normalized.origin, (url, init) => net.fetch(url, init));
    if (!probe.ok) return { ok: false, reason: probe.reason };
    try {
      return { ok: true, instance: store.add(String(name ?? ''), normalized.origin), version: probe.version };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('launcher:open', (event, id: unknown) => {
    assertLauncher(event);
    const instance = store.get(String(id));
    if (!instance) return { ok: false, reason: 'That instance is no longer in the list.' };
    openPanel(instance);
    return { ok: true };
  });
  ipcMain.handle('launcher:remove', async (event, id: unknown) => {
    assertLauncher(event);
    const instance = store.get(String(id));
    if (!instance) return { ok: true, revoked: false };
    for (const p of [...panels.values()]) if (p.instance.id === instance.id) p.window.destroy();
    const ses = session.fromPartition(partitionFor(instance));
    const token = vault.load(instance.id);
    vault.clear(instance.id);
    store.remove(instance.id);
    const revoked = token ? await revokeDesktopSession(instance.origin, token, (url, init) => ses.fetch(url, init)) : false;
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
    return { ok: true, revoked };
  });

  // Plain http to another machine: a sign-in kept on disk would be handed to
  // whatever script a network attacker injects into the page at every later
  // launch, so such instances get tab-length sessions only.
  ipcMain.handle('panel:load-refresh', (event) => {
    const { instance } = panelEntry(event);
    return instance.insecure ? null : vault.load(instance.id);
  });
  ipcMain.handle('panel:save-refresh', (event, token: unknown) => {
    const { instance } = panelEntry(event);
    if (instance.insecure) {
      vault.clear(instance.id);
      return false;
    }
    return vault.save(instance.id, String(token));
  });
  ipcMain.handle('panel:clear-refresh', (event) => {
    vault.clear(panelEntry(event).instance.id);
  });
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Instances…', accelerator: 'CmdOrCtrl+Shift+O', click: () => showLauncher() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.enableSandbox();
app.setAppUserModelId(APP_ID);

// No page anywhere in the app may embed a <webview> or open a window of its own.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showLauncher());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showLauncher();
  });
  void app.whenReady().then(() => {
    const data = app.getPath('userData');
    store = new InstanceStore(path.join(data, 'instances.json'));
    vault = new CredentialVault(path.join(data, 'credentials.json'), safeStorageCipher);
    protocol.handle(APP_SCHEME, serveLauncherFile);
    hardenLauncherSession();
    registerIpc();
    buildMenu();
    showLauncher();
  });
}
