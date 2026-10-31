import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only thing a panel page gets from the desktop shell: a place to keep
 * its refresh token between launches. The main process re-checks the sender
 * on every call; this check only keeps the bridge out of other origins'
 * pages (an identity provider during SSO) to begin with.
 */
const ORIGIN_ARG = '--nd-instance-origin=';
const origin = process.argv.find((a) => a.startsWith(ORIGIN_ARG))?.slice(ORIGIN_ARG.length);

if (origin && window.location.origin === origin) {
  contextBridge.exposeInMainWorld('ninedeployDesktop', {
    version: 1,
    loadRefreshToken: (): Promise<string | null> => ipcRenderer.invoke('panel:load-refresh'),
    saveRefreshToken: (token: string): Promise<boolean> => ipcRenderer.invoke('panel:save-refresh', String(token)),
    clearRefreshToken: (): Promise<void> => ipcRenderer.invoke('panel:clear-refresh'),
  });
}
