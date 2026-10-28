/**
 * G1.4: the sign-in claims a session carries (`amr`, `idp` on both JWTs of
 * the pair). Its own module so tests that mock `jwt.js` keep the real parser.
 */
export interface SessionAuthMethod {
  amr?: 'mfa' | 'sso';
  idp?: string;
}

/** Only well-formed claims survive a refresh. */
export function sessionAuthMethod(payload: { amr?: unknown; idp?: unknown }): SessionAuthMethod {
  if (payload.amr === 'mfa') return { amr: 'mfa' };
  if (payload.amr === 'sso' && typeof payload.idp === 'string' && /^(oidc|sso):\d{1,10}$/.test(payload.idp)) return { amr: 'sso', idp: payload.idp };
  return {};
}
