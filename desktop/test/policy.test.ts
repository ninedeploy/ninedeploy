import { describe, expect, it } from 'vitest';
import { NavigationGuard, permissionAllowed, SIGN_IN_WINDOW_MS, trustedPanelSender, windowOpenDecision } from '../src/policy.js';

const ORIGIN = 'https://panel.example.com';

describe('NavigationGuard', () => {
  it('keeps the window on the instance and sends other web pages to the browser', () => {
    const guard = new NavigationGuard(ORIGIN);
    expect(guard.decide(`${ORIGIN}/services/4`)).toBe('allow');
    expect(guard.decide('https://docs.example.org/guide')).toBe('external');
    expect(guard.decide('http://panel.example.com/')).toBe('external');
    expect(guard.decide('https://panel.example.com.evil.test/')).toBe('external');
  });

  it('never opens other schemes anywhere', () => {
    const guard = new NavigationGuard(ORIGIN);
    for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi', 'ms-settings:', 'chrome://gpu', 'not a url', 'https://user:pw@x.example/']) {
      expect(guard.decide(url), url).toBe('block');
    }
  });

  it('lets an SSO sign-in started on the panel visit the identity provider over https, then closes again', () => {
    let now = 1_000;
    const guard = new NavigationGuard(ORIGIN, () => now);
    const login = `${ORIGIN}/login`;
    expect(guard.decide('https://idp.example.net/authorize', 'redirect', login)).toBe('external');
    expect(guard.decide(`${ORIGIN}/v1/auth/oidc/corp/start?returnTo=%2F`, 'navigate', login)).toBe('allow');
    // The panel's start endpoint redirects to the provider…
    expect(guard.decide('https://idp.example.net/authorize?x=1', 'redirect', login)).toBe('allow');
    guard.arrived('https://idp.example.net/authorize?x=1');
    // …whose own pages then move between its hosts.
    expect(guard.decide('https://login.idp-cdn.example.net/mfa', 'navigate', 'https://idp.example.net/authorize?x=1')).toBe('allow');
    expect(guard.decide('http://idp.example.net/plain', 'redirect', login)).toBe('external');
    expect(guard.decide('file:///etc/passwd', 'redirect', login)).toBe('block');
    expect(guard.inSignIn()).toBe(true);
    guard.arrived(`${ORIGIN}/v1/auth/oidc/corp/callback?code=c`);
    expect(guard.inSignIn()).toBe(true);
    guard.arrived(`${ORIGIN}/auth/callback#access_token=x`);
    expect(guard.inSignIn()).toBe(false);
    expect(guard.decide('https://idp.example.net/authorize', 'redirect', login)).toBe('external');

    expect(guard.decide(`${ORIGIN}/v1/auth/github`, 'navigate', login)).toBe('allow');
    now += SIGN_IN_WINDOW_MS + 1;
    expect(guard.decide('https://github.com/login/oauth/authorize', 'redirect', login)).toBe('external');
  });

  it('never lets a panel page itself navigate the window to a foreign site, even during a sign-in', () => {
    const guard = new NavigationGuard(ORIGIN);
    // A crafted link in panel content opens the sign-in window…
    expect(guard.decide(`${ORIGIN}/v1/auth/anything`, 'navigate', `${ORIGIN}/services/1`)).toBe('allow');
    guard.arrived(`${ORIGIN}/v1/auth/anything`);
    expect(guard.inSignIn()).toBe(true);
    // …but a link clicked on a panel page still goes to the browser.
    expect(guard.decide('https://phish.example/login', 'navigate', `${ORIGIN}/v1/auth/anything`)).toBe('external');
    expect(guard.decide('https://phish.example/login', 'navigate', `${ORIGIN}/services/1`)).toBe('external');
  });
});

describe('windowOpenDecision', () => {
  it('opens web links in the browser and nothing else', () => {
    expect(windowOpenDecision('https://github.com/ninedeploy/ninedeploy')).toBe('external');
    expect(windowOpenDecision(`${ORIGIN}/services/1`)).toBe('external');
    expect(windowOpenDecision('file:///C:/')).toBe('block');
    expect(windowOpenDecision('smb://host/share')).toBe('block');
  });
});

describe('permissionAllowed', () => {
  it('grants only clipboard writes and fullscreen, and only to the instance', () => {
    expect(permissionAllowed('clipboard-sanitized-write', `${ORIGIN}/services/1`, ORIGIN)).toBe(true);
    expect(permissionAllowed('fullscreen', ORIGIN, ORIGIN)).toBe(true);
    expect(permissionAllowed('clipboard-sanitized-write', 'https://idp.example.net/', ORIGIN)).toBe(false);
    for (const p of ['media', 'geolocation', 'notifications', 'midi', 'clipboard-read', 'openExternal', 'hid', 'usb', 'serial']) {
      expect(permissionAllowed(p, ORIGIN, ORIGIN), p).toBe(false);
    }
  });
});

describe('trustedPanelSender', () => {
  it('answers the instance top frame only', () => {
    expect(trustedPanelSender(`${ORIGIN}/login`, true, ORIGIN)).toBe(true);
    expect(trustedPanelSender(`${ORIGIN}/login`, false, ORIGIN)).toBe(false);
    expect(trustedPanelSender('https://idp.example.net/login', true, ORIGIN)).toBe(false);
    expect(trustedPanelSender(undefined, true, ORIGIN)).toBe(false);
  });
});
