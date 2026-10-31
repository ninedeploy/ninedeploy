/**
 * What a panel window may show. It is pure so the rules can be tested
 * without Electron; main.ts applies the decisions to the window's events.
 */

export type NavigationDecision = 'allow' | 'external' | 'block';

/** Where SSO sign-in starts on the panel; the identity provider's pages follow it. */
const SIGN_IN_PREFIX = '/v1/auth/';
/** A sign-in that has not come back by then is abandoned; foreign pages go to the browser again. */
export const SIGN_IN_WINDOW_MS = 10 * 60_000;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function sameOrigin(url: string, origin: string): boolean {
  return parse(url)?.origin === origin;
}

/** Only web addresses leave for the system browser; file:, javascript:, custom schemes and the rest never do. */
export function isExternalWebUrl(url: string): boolean {
  const parsed = parse(url);
  return !!parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password;
}

/**
 * Per-window navigation state. The window stays on the instance's origin,
 * with one exception: a sign-in started on the panel itself (SSO through
 * OIDC, GitHub or SAML) may visit the identity provider over https until it
 * returns to the panel or times out. Even then a page of the panel cannot
 * send the window elsewhere: the way out is a server redirect, and from the
 * provider's own pages onward the provider navigates. A link clicked on the
 * panel still goes to the system browser.
 */
export class NavigationGuard {
  private signInUntil = 0;

  constructor(
    readonly origin: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A top-level navigation (`kind: 'navigate'`, started by the page or the
   * user on `fromUrl`) or a server redirect within one.
   */
  decide(url: string, kind: 'navigate' | 'redirect' = 'navigate', fromUrl = ''): NavigationDecision {
    const target = parse(url);
    if (!target) return 'block';
    if (target.origin === this.origin) {
      if (target.pathname.startsWith(SIGN_IN_PREFIX)) this.signInUntil = this.now() + SIGN_IN_WINDOW_MS;
      return 'allow';
    }
    const fromPanel = parse(fromUrl)?.origin === this.origin;
    if (this.inSignIn() && target.protocol === 'https:' && (kind === 'redirect' || !fromPanel)) return 'allow';
    return isExternalWebUrl(url) ? 'external' : 'block';
  }

  /** The window finished loading `url`; back on the panel ends any sign-in detour. */
  arrived(url: string): void {
    const target = parse(url);
    if (target?.origin === this.origin && !target.pathname.startsWith(SIGN_IN_PREFIX)) this.signInUntil = 0;
  }

  inSignIn(): boolean {
    return this.now() < this.signInUntil;
  }
}

/** New windows never open inside the app: web links go to the system browser, anything else nowhere. */
export function windowOpenDecision(url: string): 'external' | 'block' {
  return isExternalWebUrl(url) ? 'external' : 'block';
}

/**
 * Permissions a panel page may get. Copy buttons use the sanitized clipboard
 * write, and terminal/log views may go fullscreen; the camera, microphone,
 * location, notifications, MIDI, USB, HID and the rest are refused.
 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

export function permissionAllowed(permission: string, requestingUrl: string, origin: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && sameOrigin(requestingUrl, origin);
}

/** The credential bridge answers only the instance's own top frame — never an iframe, never the identity provider. */
export function trustedPanelSender(frameUrl: string | undefined, isMainFrame: boolean, origin: string): boolean {
  return isMainFrame && typeof frameUrl === 'string' && sameOrigin(frameUrl, origin);
}
