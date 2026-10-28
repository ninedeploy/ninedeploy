# Security & Single Sign-On (SSO)

NineDeploy follows a defense-in-depth security model to protect secrets at rest, API access, user authentication, and system communication.

For 0.10.2 upgrades, read [SSO account linking](SSO_ACCOUNT_LINKING.md): existing accounts must explicitly link their provider before SSO sign-in. Local TOTP requirements remain in force.

---

## 🔒 1. Dual-Vault Secret Encryption & Key Rotation

- **AES-256-GCM Envelope Encryption**: Secrets, database passwords, and environment variables are sealed using versioned envelopes: `v<version>:<iv>:<tag>:<ciphertext>`.
- **Key Rotation**: Multiple master keys can be configured simultaneously via `NINEDEPLOY_MASTER_KEYS=0:<key0>,1:<key1>`.
- **Re-encryption**: Existing secrets encrypted with older keys continue to decrypt seamlessly and are migrated to the active key version upon update.

---

## 🌐 2. OpenID Connect (OIDC) Single Sign-On

Integrate enterprise identity providers for unified authentication — configured per provider from **Settings → SSO** by an operator (no `.env` values involved):
- **Supported Providers**: Google Workspace, GitHub OAuth/Enterprise, Okta, Keycloak, Authentik, Microsoft Entra ID, and any generic OIDC issuer.
- **Automated User Provisioning**: Auto-create user accounts based on verified OIDC claims (`email`, `email_verified`, `name`), with auto-enrollment toggles per provider.
- **Workspace of an enrolled user**: a user an OIDC provider auto-enrolls always owns their own personal workspace. OIDC providers map users into no team workspace: add people to team workspaces with invitations (each carries its own role) or SCIM. The provider's `defaultRole` field is **deprecated**: the API still accepts and returns it so existing clients keep working, but it has no effect on sign-in, and the settings form no longer shows it.
- **Browser-bound hand-off**: the provider's callback is bound to the browser that started the flow twice over — an HttpOnly state cookie on the server side, and a per-tab one-time nonce on the web side. The panel tab that clicks an SSO button stores a random nonce, the server signs it into the OAuth state and echoes it back with the session tokens, and the panel accepts tokens only on its `/auth/callback` route and only when that nonce matches. Tokens pasted into any other link (`/#access_token=…`) are discarded, so nobody can sign your tab into *their* account. The post-login `returnTo` must be a same-origin path. A sign-in started from a page loaded before an update (no nonce) is refused with "please sign in again"; clicking the provider button once more completes it.
- **Domain Restriction**: Each provider takes an optional list of allowed email domains (Settings → SSO → *Allowed email domains*, e.g. `company.com, company.io`). When set, every sign-in, auto-enrollment and account link through that provider must present an IdP-verified email in one of those domains (exact match — list subdomains explicitly); anything else is refused with `sso_domain_not_allowed` before an account is created or a session issued, and logged as `auth.sso_domain_refused`. An empty list (the default, and what every provider has after upgrading) accepts any verified email. With auto-enroll on and no domain list, the settings page warns: for a public provider such as GitHub or Google that means *anyone* can create an account.

---

### SAML sign-in (G3.6)

SAML identity providers sign people in to the panel. Add one under **Settings → SSO → SAML identity providers** with the IdP's metadata XML and the email domains whose accounts may use it. The API equivalent is `POST /v1/sso/providers` with `{ "type": "saml", "name": "corp", "config": { "idpMetadataXml": "…", "emailDomains": ["corp.example"] } }`; instead of the metadata you can give `entryPoint` and `idpCert`. Give the IdP the provider's metadata URL, `/v1/auth/saml/<id>/metadata`. That is the entity id, and its consumer URL is `/v1/auth/saml/<id>/acs`.

**Verification**
- Responses are verified with `@node-saml/node-saml` 5.1.0, which uses xml-crypto with exclusive canonicalization and the enveloped-signature transform. This replaces the hand-written verifier that could never match a real IdP.
- **Request binding:** sign-in is SP-initiated only. A response must answer an AuthnRequest this panel sent in the last 10 minutes, and each request id is accepted once, so a captured response cannot be replayed.
- **Signature and audience:** the assertion must be signed by the provider's certificate and addressed to this panel's entity id, with one minute of clock skew. Signature wrapping is refused.

**Who gets a session**
- Like OIDC, a SAML identity (provider + NameID) signs in only the account it was linked to. The link is made from that account's own signed-in session: Settings → Account → *Link <provider>*, `POST /v1/auth/saml/:id/link`. The IdP must answer with that account's email, and that email must be in `emailDomains`.
- An existing account without the link gets 403 `account_link_required`, and there is no auto-enrolment.
- A link is bound to the IdP configuration (sign-in URL, certificate, issuer), so changing it asks everyone to link again.
- With `emailAttribute` set, only that attribute is read as the email.
- An account with two-factor authentication signs in with its password and code instead.
- The session reaches the browser the same way as an OIDC sign-in: through `/auth/callback`, only in the tab whose nonce started it.
- It carries `amr: "sso"` and `idp: "sso:<id>"`, so a workspace can exempt it from its 2FA requirement.

**Testing:** the flow is checked end to end with a real AuthnRequest and RSA-SHA256 signed responses. The tests cover linking, a success, replay, another key, another audience, wrapping, an unsolicited response, the link, domain and account checks, and a forged RelayState.

## 🔑 3. Multi-Factor Authentication & Passkeys

- **Passkeys (WebAuthn / FIDO2)**: Passwordless biometric authentication (Touch ID, Face ID, YubiKey) with hardware-backed security.
- **Two-Factor Authentication (TOTP)**: RFC 6238 compliant 6-digit TOTP with QR code setup and ±30s clock-drift tolerance.
- **Recovery codes (0.16.3)**: turning 2FA on hands out ten single-use recovery codes, shown once. At sign-in, one of them stands in for the authenticator code ("Lost your authenticator? Use a recovery code"; the CLI takes one at the same prompt). Only their SHA-256 is stored; a wrong one counts toward lockout like a wrong 2FA code. Settings → Account shows how many are left and creates a new set, which needs the password and a current 2FA code and replaces the old one. Turning 2FA off or enrolling again deletes the set. Accounts that turned 2FA on before 0.16.3 have no codes until they create a set. API: `GET`/`POST /v1/auth/2fa/recovery-codes`, `recoveryCode` on `POST /v1/auth/login`.
- **Workspace-enforced 2FA (G1.4)**: a workspace admin or owner can require every member to sign in with a second factor (Workspaces → *Require two-factor authentication*, or `PUT /v1/workspaces/:id/two-factor` with `{ "required": true }`).
  - **What counts:** what the session proved, not what the account holds. A sign-in with TOTP, a recovery code or a passkey marks the session `amr: "mfa"` (a JWT claim that survives refreshes).
  - **Who is held:** any other session of a member gets 403 `two_factor_required` from every route except `GET /v1/auth/me`, `GET /v1/auth/status`, `GET /v1/auth/2fa/requirement` and logout.
  - **Accounts with no second factor:** they may also set up TOTP or a passkey, then sign out and sign in again with it. An account that already has one only signs in again, so a session holding just the password cannot add a factor of its own and pass with it.
  - **SSO exemption:** sessions from the SSO providers the workspace lists in `ssoExemptProviders` (`oidc:<id>`, `sso:<id>`) are exempt, for an IdP that enforces MFA itself. Such a session carries `amr: "sso"` and `idp`. GitHub sign-ins carry no provider and are never exempt.
  - **What is not held:** API tokens the member already holds keep working; a held session cannot create new ones.
  - **Turning it on:** the admin's own session must pass the requirement (409 `enrol_first`). Sessions signed in before an upgrade carry no `amr` and sign in again. It is audited as `workspace.two_factor.set`.
  - **Storage:** no migration is needed; it is a settings row per workspace.
- **Argon2id Password Hashing**: State-of-the-art memory-hard password hashing with automatic salt generation.

---

## 🛡️ 4. Brute-Force Lockout & Rate Limiting

- **Per-Source Lockout**: 5 failed sign-ins (wrong password or wrong 2FA code) for one account from one source lock *that source* out of that account for 15 minutes. A source is one IPv4 address or one IPv6 /64. The real user, signing in from anywhere else, is unaffected — a stranger who knows an email cannot hold its owner locked out.
- **Per-Account Lockout**: 25 failures for one account inside a sliding 15-minute window, from more than one source, lock the account for 15 minutes from every source (logged as `auth.lockout`). Failures from sources that already locked themselves keep counting, so spreading 5 guesses each over many addresses still trips it. A successful sign-in clears only that source's own failures; it never lifts a lock early.
- **Responses do not leak state**: a locked account, a wrong password and an unknown email all answer `Invalid email or password`, and an unknown email pays the same password-hash verification as a real one.
- **IP Rate Limiting**: Tiered token bucket rate limits on public endpoints to prevent credential stuffing and DoS attacks.

## 🕳️ 5. Egress Controls

Operator-supplied URLs whose targets are normally public — notification channels, log drains, push delivery, git clones and PR inspections, OAuth token exchange, the marketplace catalog and `templates_source` — are resolved through a guarded fetch that refuses private, loopback, link-local, CGNAT and multicast addresses (including the cloud metadata endpoint `169.254.169.254`). Self-hosted LAN remotes keep working with `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`.

The guard is deliberately **not** applied to the OIDC issuer, the S3 endpoint, the log-search backend or the telemetry endpoint: self-hosted Keycloak, MinIO and Loki normally *are* on a private address, so guarding those would break working installs. All of them are operator-only settings, and an operator can already run host commands through a service — the guard is defence in depth against a copy-pasted URL, not a privilege boundary.

The 0.14 secret managers (HashiCorp Vault / OpenBao, AWS Secrets Manager and its STS calls) **are** guarded, and never follow a redirect: a Vault on a private address needs `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`, and instance metadata credentials are refused. The Infisical and Doppler calls go to their fixed public hosts. See [SECRET_MANAGERS.md](./SECRET_MANAGERS.md).
