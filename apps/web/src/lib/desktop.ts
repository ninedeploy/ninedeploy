/**
 * R6: the desktop client's credential bridge. Inside the NineDeploy desktop
 * app the panel window gets `window.ninedeployDesktop`, which keeps the
 * refresh token in the OS credential store (DPAPI, Keychain, libsecret) so a
 * sign-in survives closing the window. In a browser it is absent and the
 * session stays in sessionStorage only, as before.
 */
export interface DesktopBridge {
  version: number;
  loadRefreshToken(): Promise<string | null>;
  saveRefreshToken(token: string): Promise<boolean>;
  clearRefreshToken(): Promise<void>;
}

export function desktopBridge(): DesktopBridge | null {
  const candidate = (globalThis as { ninedeployDesktop?: Partial<DesktopBridge> }).ninedeployDesktop;
  if (
    !candidate ||
    candidate.version !== 1 ||
    typeof candidate.loadRefreshToken !== 'function' ||
    typeof candidate.saveRefreshToken !== 'function' ||
    typeof candidate.clearRefreshToken !== 'function'
  ) {
    return null;
  }
  return candidate as DesktopBridge;
}

/** Mirror a refresh-token change into the desktop store. Never throws: the tab session works without it. */
export function persistDesktopRefreshToken(token: string | null): void {
  const bridge = desktopBridge();
  if (!bridge) return;
  try {
    const done = token ? bridge.saveRefreshToken(token) : bridge.clearRefreshToken();
    void Promise.resolve(done).catch(() => undefined);
  } catch {
    // A disconnected native bridge must not interrupt the tab's session.
  }
}

/** The refresh token the desktop app kept from an earlier window, if any. */
export async function loadDesktopRefreshToken(): Promise<string | null> {
  const bridge = desktopBridge();
  if (!bridge) return null;
  try {
    const token = await bridge.loadRefreshToken();
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
