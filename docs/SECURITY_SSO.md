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
- **Domain Restriction**: Enforce organizational domain matching (e.g. only allow `@company.com`).

---

## 🔑 3. Multi-Factor Authentication & Passkeys

- **Passkeys (WebAuthn / FIDO2)**: Passwordless biometric authentication (Touch ID, Face ID, YubiKey) with hardware-backed security.
- **Two-Factor Authentication (TOTP)**: RFC 6238 compliant 6-digit TOTP with QR code setup and ±30s clock-drift tolerance.
- **Argon2id Password Hashing**: State-of-the-art memory-hard password hashing with automatic salt generation.

---

## 🛡️ 4. Brute-Force Lockout & Rate Limiting

- **Per-Account Lockout**: 5 consecutive failed login attempts lock an account for 15 minutes.
- **IP Rate Limiting**: Tiered token bucket rate limits on public endpoints to prevent credential stuffing and DoS attacks.

## 🕳️ 5. Egress Controls

Operator-supplied URLs whose targets are normally public — notification channels, log drains, push delivery, git clones and PR inspections, OAuth token exchange, the marketplace catalog and `templates_source` — are resolved through a guarded fetch that refuses private, loopback, link-local, CGNAT and multicast addresses (including the cloud metadata endpoint `169.254.169.254`). Self-hosted LAN remotes keep working with `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`.

The guard is deliberately **not** applied to the OIDC issuer, the S3 endpoint, the Vault address, the log-search backend or the telemetry endpoint: self-hosted Keycloak, MinIO, Vault and Loki normally *are* on a private address, so guarding those would break working installs. All of them are operator-only settings, and an operator can already run host commands through a service — the guard is defence in depth against a copy-pasted URL, not a privilege boundary.
