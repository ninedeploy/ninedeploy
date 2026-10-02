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
- **Domain Restriction**: Each provider takes an optional list of allowed email domains (Settings → SSO → *Allowed email domains*, e.g. `company.com, company.io`). When set, every sign-in, auto-enrollment and account link through that provider must present an IdP-verified email in one of those domains (exact match — list subdomains explicitly); anything else is refused with `sso_domain_not_allowed` before an account is created or a session issued, and logged as `auth.sso_domain_refused`. An empty list (the default, and what every provider has after upgrading) accepts any verified email. With auto-enroll on and no domain list, the settings page warns: for a public provider such as GitHub or Google that means *anyone* can create an account.

---

## 🔑 3. Multi-Factor Authentication & Passkeys

- **Passkeys (WebAuthn / FIDO2)**: Passwordless biometric authentication (Touch ID, Face ID, YubiKey) with hardware-backed security.
- **Two-Factor Authentication (TOTP)**: RFC 6238 compliant 6-digit TOTP with QR code setup and ±30s clock-drift tolerance.
- **Argon2id Password Hashing**: State-of-the-art memory-hard password hashing with automatic salt generation.

---

## 🛡️ 4. Brute-Force Lockout & Rate Limiting

- **Per-Source Lockout**: 5 failed sign-ins (wrong password or wrong 2FA code) for one account from one source lock *that source* out of that account for 15 minutes. A source is one IPv4 address or one IPv6 /64. The real user, signing in from anywhere else, is unaffected — a stranger who knows an email cannot hold its owner locked out.
- **Per-Account Lockout**: 25 failures for one account inside a sliding 15-minute window, from more than one source, lock the account for 15 minutes from every source (logged as `auth.lockout`). Failures from sources that already locked themselves keep counting, so spreading 5 guesses each over many addresses still trips it. A successful sign-in clears only that source's own failures; it never lifts a lock early.
- **Responses do not leak state**: a locked account, a wrong password and an unknown email all answer `Invalid email or password`, and an unknown email pays the same password-hash verification as a real one.
- **IP Rate Limiting**: Tiered token bucket rate limits on public endpoints to prevent credential stuffing and DoS attacks.

## 🕳️ 5. Egress Controls

Operator-supplied URLs whose targets are normally public — notification channels, log drains, push delivery, git clones and PR inspections, OAuth token exchange, the marketplace catalog and `templates_source` — are resolved through a guarded fetch that refuses private, loopback, link-local, CGNAT and multicast addresses (including the cloud metadata endpoint `169.254.169.254`). Self-hosted LAN remotes keep working with `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`.

The guard is deliberately **not** applied to the OIDC issuer, the S3 endpoint, the Vault address, the log-search backend or the telemetry endpoint: self-hosted Keycloak, MinIO, Vault and Loki normally *are* on a private address, so guarding those would break working installs. All of them are operator-only settings, and an operator can already run host commands through a service — the guard is defence in depth against a copy-pasted URL, not a privilege boundary.
