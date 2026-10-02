import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ setSessionTokens: vi.fn() }));
vi.mock('../src/lib/api.js', () => apiMock);

import {
  beginSso,
  clearSsoFragmentResult,
  safeReturnTo,
  SSO_CALLBACK_PATH,
  SSO_REFUSED_MESSAGE,
  SSO_STALE_MESSAGE,
  takeSsoFragment,
} from '../src/lib/sso.js';

const NONCE_KEY = 'ninedeploy.ssoNonce';
const AT = ['sso', 'access'].join('-');
const RT = ['sso', 'refresh'].join('-');

function land(path: string, fragment: Record<string, string>) {
  window.history.replaceState(null, '', `${path}#${new URLSearchParams(fragment).toString()}`);
}

describe('safeReturnTo (r505)', () => {
  it('keeps same-origin paths with their query and hash', () => {
    expect(safeReturnTo('/services/4?tab=logs#top')).toBe('/services/4?tab=logs#top');
  });

  it.each([
    ['//evil.example/x'],
    ['/\\evil.example'],
    ['https://evil.example/'],
    ['javascript:alert(1)'],
    ['/\t/evil.example'],
    ['services'],
    [''],
    [undefined],
    [42],
  ])('refuses %j', (raw) => {
    expect(safeReturnTo(raw)).toBe('/');
  });

  it('never returns to the auth pages themselves (no loops)', () => {
    expect(safeReturnTo('/login?x=1')).toBe('/');
    expect(safeReturnTo(SSO_CALLBACK_PATH)).toBe('/');
  });
});

describe('beginSso (r505)', () => {
  afterEach(() => sessionStorage.clear());

  it('stores a fresh nonce and sends it, with the validated return path, to the start route', () => {
    const url = new URL(beginSso('/v1/auth/oidc/github/login', '//evil.example'), window.location.origin);
    const stored = sessionStorage.getItem(NONCE_KEY)!;
    expect(stored).toMatch(/^[0-9a-f]{48}$/);
    expect(url.pathname).toBe('/v1/auth/oidc/github/login');
    expect(url.searchParams.get('nonce')).toBe(stored);
    expect(url.searchParams.get('returnTo')).toBe('/');
    // Each start mints a new nonce.
    beginSso('/v1/auth/oidc/github/login', '/');
    expect(sessionStorage.getItem(NONCE_KEY)).not.toBe(stored);
  });

  it('appends to an auth URL that already has a query', () => {
    expect(beginSso('/v1/auth/oidc/x/login?prompt=1', '/services')).toMatch(/\?prompt=1&returnTo=%2Fservices&nonce=/);
  });
});

describe('takeSsoFragment (r505)', () => {
  beforeEach(() => {
    apiMock.setSessionTokens.mockClear();
    clearSsoFragmentResult();
  });
  afterEach(() => {
    sessionStorage.clear();
    clearSsoFragmentResult();
    window.history.replaceState(null, '', '/');
  });

  it('accepts tokens on the callback route when the nonce matches, then forgets the nonce', () => {
    sessionStorage.setItem(NONCE_KEY, 'n-123');
    land(SSO_CALLBACK_PATH, { access_token: AT, refresh_token: RT, nonce: 'n-123', return_to: '/services' });
    expect(takeSsoFragment()).toEqual({ kind: 'accepted', returnTo: '/services' });
    expect(apiMock.setSessionTokens).toHaveBeenCalledWith(AT, RT);
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem(NONCE_KEY)).toBeNull();
  });

  it('answers the same outcome to a second call in the same page load (StrictMode)', () => {
    sessionStorage.setItem(NONCE_KEY, 'n-1');
    land(SSO_CALLBACK_PATH, { access_token: AT, nonce: 'n-1' });
    const first = takeSsoFragment();
    expect(takeSsoFragment()).toBe(first);
    expect(apiMock.setSessionTokens).toHaveBeenCalledTimes(1);
  });

  it('refuses a fragment whose nonce this tab never issued (session swap)', () => {
    sessionStorage.setItem(NONCE_KEY, 'mine');
    land(SSO_CALLBACK_PATH, { access_token: AT, refresh_token: RT, nonce: 'attackers' });
    expect(takeSsoFragment()).toEqual({ kind: 'refused', message: SSO_REFUSED_MESSAGE });
    expect(apiMock.setSessionTokens).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });

  it('refuses a fragment when no sign-in was started from this tab', () => {
    land(SSO_CALLBACK_PATH, { access_token: AT, nonce: 'anything' });
    expect(takeSsoFragment().kind).toBe('refused');
    expect(apiMock.setSessionTokens).not.toHaveBeenCalled();
  });

  it('refuses tokens on any route other than the callback, even with the right nonce', () => {
    sessionStorage.setItem(NONCE_KEY, 'n-2');
    land('/settings', { access_token: AT, nonce: 'n-2' });
    expect(takeSsoFragment().kind).toBe('refused');
    expect(apiMock.setSessionTokens).not.toHaveBeenCalled();
  });

  it('refuses the legacy nonce-less fragment with the "sign in again" message', () => {
    land('/', { access_token: AT, refresh_token: RT });
    expect(takeSsoFragment()).toEqual({ kind: 'refused', message: SSO_STALE_MESSAGE });
    expect(apiMock.setSessionTokens).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });

  it('refuses an empty access token', () => {
    sessionStorage.setItem(NONCE_KEY, 'n-3');
    land(SSO_CALLBACK_PATH, { access_token: '', nonce: 'n-3' });
    expect(takeSsoFragment().kind).toBe('refused');
  });

  it('ignores a URL without tokens', () => {
    window.history.replaceState(null, '', '/services#section');
    expect(takeSsoFragment()).toEqual({ kind: 'none' });
    expect(window.location.hash).toBe('#section');
  });

  it('sanitises the return path the fragment carries', () => {
    sessionStorage.setItem(NONCE_KEY, 'n-4');
    land(SSO_CALLBACK_PATH, { access_token: AT, nonce: 'n-4', return_to: '//evil.example' });
    expect(takeSsoFragment()).toEqual({ kind: 'accepted', returnTo: '/' });
  });
});
