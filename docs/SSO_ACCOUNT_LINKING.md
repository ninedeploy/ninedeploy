# SSO account linking

Starting with 0.10.2, a verified provider email does not automatically link to an existing local account. NineDeploy records the provider and stable subject after explicit linking, or atomically when SSO creates a new account. Subsequent sign-ins use this identity record.

For an existing account, sign in with its password/passkey, open account settings, and link the provider. The API is `POST /v1/auth/oidc/:slug/link` with the interactive access token. It returns `{ "authUrl": "..." }`; navigate the same browser to that URL. The callback checks the initiating session is still live, the account's token version is unchanged, and the verified provider email matches the local account. API tokens cannot initiate linking. Successful browser linking returns to `/settings?oidcLinked=1` without issuing new session credentials.

If sign-in returns `account_link_required`, sign in locally and link the provider. Legacy SSO-only accounts have no historical identity mapping: use the password-reset email flow to recover local access, then link the provider. Configure a working system email channel before upgrading an installation that relies exclusively on SSO. NineDeploy does not infer links from old audit logs or matching email addresses.

Changing an OIDC provider's issuer or client ID invalidates its existing links. Users must link the new provider configuration again. Deleting the provider also deletes its links.

Mailbox-based password recovery revokes all existing sessions, API tokens, passkeys, and SSO links atomically with the password change. Register passkeys and link SSO providers again after recovery. This prevents credentials planted before mailbox ownership was proved from retaining access. An ordinary authenticated password change keeps its existing behavior.

Accounts with local TOTP enabled must continue using password and code for sign-in until an SSO second-factor challenge exists. Linking from an already authenticated local session is permitted, but it does not disable that requirement.
