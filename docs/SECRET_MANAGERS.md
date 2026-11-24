# Secret managers: Vault / OpenBao, AWS, GCP, Azure, 1Password and exec

From 0.14, an environment value can reference a secret held in **HashiCorp Vault** or **OpenBao** (KV version 2) or in **AWS Secrets Manager**. The panel fetches the secret when a deploy starts and passes the value to the container. It never stores the value.

These two providers run alongside the existing instance-wide Infisical or Doppler provider (Settings → Integrations → Vault provider, `/v1/settings/vault`), which is unchanged.

Five more reference forms arrived in 0.18.10, first written in the unpublished 0.18.5 candidate (AWS Parameter Store, GCP Secret Manager, Azure Key Vault, 1Password Connect and a local exec command); they are described in §3a. The panel calls all of these the **secret managers** (Settings → Integrations → Secret managers, `/v1/settings/secret-providers`), as distinct from the older **Vault provider** card that holds Infisical or Doppler.

---

## 1. Reference syntax

| Reference | Resolves to |
| :--- | :--- |
| `${{vault:<path>#<field>}}` | One field of a KV v2 secret. `<path>` is relative to the configured mount. |
| `${{aws:<secretId>}}` | The whole `SecretString` of a secret. `<secretId>` is a secret name or a full ARN. |
| `${{aws:<secretId>#<jsonKey>}}` | One key of a `SecretString` that holds a JSON object. |
| `${{infisical:KEY}}` / `${{doppler:KEY}}` | The existing provider, unchanged. |

- **Vault paths** are segments of `A-Z a-z 0-9 _ . -` joined by `/`, with no leading `/` and no `.` or `..` segment. Fields use the same characters.
- **AWS secret ids** use `A-Z a-z 0-9 / _ + = . @ : -` (up to 2048 characters), so both names and ARNs work. JSON keys use `A-Z a-z 0-9 _ . -`.
- A reference can sit inside a longer value, and one value can hold several:

  ```text
  DATABASE_URL=postgres://app:${{vault:apps/billing/prod#db_password}}@db:5432/app
  STRIPE_KEY=${{aws:prod/billing#stripe_key}}
  LICENSE=${{aws:arn:aws:secretsmanager:eu-west-1:123456789012:secret:license-AbCdEf}}
  ```

- A string field is used as it is. Any other JSON value (a number, an object) is passed as its JSON text.
- A string that does not match this grammar is not a reference anywhere, not at deploy time and not at any write gate.

---

## 2. HashiCorp Vault / OpenBao

Configure it under **Settings → Integrations → Secret managers**, with `ninedeploy secrets providers set-vault`, or with `PUT /v1/settings/secret-providers/vault`:

```json
{
  "config": {
    "address": "https://vault.example.com",
    "namespace": "team-a",
    "mount": "secret",
    "authMethod": "approle",
    "approleMount": "approle"
  },
  "credentials": { "roleId": "…", "secretId": "…" }
}
```

| Field | Meaning |
| :--- | :--- |
| `address` | `https://` only. `http://` is accepted only with `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`. No credentials, query or fragment. |
| `namespace` | Optional. Sent as `X-Vault-Namespace` (Vault Enterprise, OpenBao namespaces). |
| `mount` | The KV v2 mount (default `secret`). Reads go to `GET /v1/<mount>/data/<path>`. |
| `authMethod` | `token` (credentials `{token}`) or `approle` (credentials `{roleId, secretId}`). |
| `approleMount` | The AppRole auth mount (default `approle`). |

- **KV version 2 only.** A mount that answers without `data.data` is reported as "not a KV version 2 engine". KV version 1 is not supported.
- **Token auth does not renew the token.** Use a periodic token, or AppRole. With AppRole, the panel logs in and caches the client token until 60 seconds before its lease ends. Saving the provider again drops the cached token.
- **A private CA:** start the panel with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.
- **A Vault on your LAN** (a private, loopback or link-local address) is refused by the egress guard unless `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1` is set; the error says so.
- **Test** (`POST /v1/settings/secret-providers/vault/test`, optional `{probePath}`) calls `auth/token/lookup-self`, or performs a fresh AppRole login, and then reads `probePath` if you give one.

A minimal setup:

```bash
vault secrets enable -path=secret kv-v2          # skip if the mount exists
vault kv put secret/apps/billing/prod db_password='…'

vault policy write ninedeploy - <<'EOF'
path "secret/data/apps/*" { capabilities = ["read"] }
EOF

# Either a periodic token …
vault token create -policy=ninedeploy -period=24h
# … or AppRole
vault auth enable approle
vault write auth/approle/role/ninedeploy token_policies=ninedeploy token_ttl=1h token_max_ttl=4h
vault read auth/approle/role/ninedeploy/role-id
vault write -f auth/approle/role/ninedeploy/secret-id
```

---

## 3. AWS Secrets Manager

Configure it under **Settings → Integrations → Secret managers**, with `ninedeploy secrets providers set-aws`, or with `PUT /v1/settings/secret-providers/aws`:

```json
{
  "config": {
    "region": "eu-west-1",
    "roleArn": "arn:aws:iam::123456789012:role/ninedeploy-secrets",
    "externalId": "ninedeploy-prod",
    "roleSessionName": "ninedeploy"
  },
  "credentials": { "accessKeyId": "AKIA…", "secretAccessKey": "…" }
}
```

| Field | Meaning |
| :--- | :--- |
| `region` | For example `eu-west-1` or `us-gov-west-1`. Calls go to `https://secretsmanager.<region>.amazonaws.com/` (`.amazonaws.com.cn` for `cn-` regions). |
| `endpoint` | Optional. A VPC endpoint or a compatible service; `https://` (http only with private egress). |
| `roleArn` | Optional. The panel calls STS `AssumeRole` (regional endpoint) with the stored key and caches the session until 5 minutes before it expires. |
| `externalId` | Optional; needs `roleArn`. |
| `roleSessionName` | Default `ninedeploy`. |
| credentials | `accessKeyId` (`AKIA…` or `ASIA…`), `secretAccessKey`, and `sessionToken` for temporary keys. |

- Requests are `secretsmanager.GetSecretValue`, signed with SigV4. No AWS SDK is involved.
- **Instance and ECS roles (IMDS) are not supported.** The egress guard blocks link-local addresses, so store an access key. Point it at a role with `roleArn` if you prefer short sessions.
- `SecretBinary` secrets are refused; store the value as a `SecretString`. A `#jsonKey` needs a `SecretString` that is a JSON object.
- **Test** (`POST /v1/settings/secret-providers/aws/test`, optional `{probeSecretId}`) calls STS `GetCallerIdentity`, performs a fresh `AssumeRole` when `roleArn` is set, and then reads `probeSecretId` if you give one.

The IAM policy the key (or the assumed role) needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": "arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/*" }
  ]
}
```

With `roleArn`, the key's own identity also needs `sts:AssumeRole` on that role, and the role's trust policy must allow it (with the `sts:ExternalId` condition when you set `externalId`). A secret encrypted with a customer-managed KMS key also needs `kms:Decrypt` on that key.

---

## 3a. More secret managers (G3.2)

Five more reference forms. All except `op` also accept `#<jsonKey>`, which reads one key of a value that holds a JSON object.

| Reference | Provider | Settings |
| :--- | :--- | :--- |
| `${{ssm:<name>}}` | AWS Systems Manager **Parameter Store**. SecureString values are decrypted; a `StringList` comes back comma-joined, as AWS stores it. | Uses the **aws** provider above: the same key or assumed role, and the same region. It always uses the regional public `ssm` endpoint, because a custom `endpoint` names Secrets Manager only. The identity needs `ssm:GetParameter` (and `kms:Decrypt` for a customer-managed key). |
| `${{gcp:<secret>[@<version>]}}` | **GCP Secret Manager**. The version defaults to `latest`. | A service account JSON key, plus `projectId` (optional; defaults to the key's project). The account needs *Secret Manager Secret Accessor*. The assertion is only ever sent to `oauth2.googleapis.com`, whatever `token_uri` the key file names. A binary (non-UTF-8) payload is refused. |
| `${{azure:<name>[@<version>]}}` | **Azure Key Vault** | `vaultUrl` (`https://<name>.vault.azure.net`, or the China or US Gov equivalent; other hosts are refused), `tenantId`, `clientId` and a client secret. The secret goes only to Microsoft Entra ID for that vault's cloud. The app needs *Key Vault Secrets User* or a get-secret access policy. A new tenant, client id **or vault URL** needs the secret again: a token for `vault.azure.net` works at any vault. |
| `${{op:<vault>/<item>[/<section>]/<field>}}` | **1Password Connect** | The Connect server `address` and an access token. Each part is a name or a 26-character id. A name that matches nothing, or more than one entry, fails the deploy; the error names that part (never a value). A Connect server on a private network needs `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`. |
| `${{exec:<name>}}` | The operator's **exec command** | Off unless the panel was started with `NINEDEPLOY_SECRET_EXEC=1`; without it the provider can be neither saved nor used. See below. |

**The exec provider.** It covers any secret manager that has a command-line client: Bitwarden (`bw`), Doppler, `op`, `pass`, sops, or a script.

- **How it runs:** the operator stores an argv of 1 to 32 arguments (each at most 1024 characters, the first an absolute path; the panel takes one argument per line), for example `["/usr/local/bin/bw", "get", "password", "{name}"]`, and a timeout (1–60 s, default 10). At deploy time the panel runs the argv **without a shell**:
  - `{name}` in any argument is replaced by the reference name;
  - the name is also passed in `NINEDEPLOY_SECRET_NAME`;
  - the command gets only `PATH`, `HOME` and that variable, never the panel's own environment.
- **Where it runs:** as the panel process, so in a Docker install inside the panel's own container. The official image ships no secret-manager client, only its build and deploy tools (Node, Git, Docker with the Compose plugin, Nixpacks, Railpack, `pack`, buildx and curl), so the program has to be added to or mounted into that container.
- **The value:** stdout, minus one trailing newline.
- **Failures:** a non-zero exit, the timeout or more than 64 KiB of output fails the deploy. The first 200 characters of stderr are shown.
- **Names:** reference names use `A-Z a-z 0-9 _ . / : @ -`, never start with `-` (as its own argument a name could otherwise read as an option) and never contain a `..` segment. It is still the command that decides what a name may reach: put `--` before `{name}` where the client supports it.

Settings → Integrations → *Secret managers* has a panel for each of these kinds; Parameter Store uses the AWS panel. The CLI can save only the Vault and AWS providers (`set-vault`, `set-aws`): configure GCP, Azure, 1Password and exec in the panel, or with `PUT /v1/settings/secret-providers/<kind>` (`client.settings.secretProviders.set(kind, …)` in the SDK). **Test connection** takes an optional probe:

- gcp, azure, onepassword and exec: a reference name to resolve;
- aws: `probeSecretId`, a secret to read, in the panel; `probeParameter`, a Parameter Store parameter to read, through the API, the SDK or `--probe-parameter` (both may be given together).

`ninedeploy secrets providers list|test|delete` accepts every kind. Credentials never travel on the command line: `set-vault` reads a token or the AppRole ids from `--token-file`, `--role-id-file` and `--secret-id-file` (or `NINEDEPLOY_VAULT_TOKEN`, `NINEDEPLOY_VAULT_ROLE_ID` and `NINEDEPLOY_VAULT_SECRET_ID`), and `set-aws` the secret key and session token from `--secret-access-key-file` and `--session-token-file` (or `NINEDEPLOY_AWS_SECRET_ACCESS_KEY` and `NINEDEPLOY_AWS_SESSION_TOKEN`). Only the access key id is a flag (`--access-key-id`, or `NINEDEPLOY_AWS_ACCESS_KEY_ID`).

The column that names the kind is plain text, so these kinds need **no migration**. Existing text of these shapes in env values stays literal, with a warning, until its provider is configured, as in §6. The new forms do become subject to the write gates and the preview withholding in §4.

---

## 4. Who may use references

The instance-wide **allowlist** that governs Infisical and Doppler references (Settings → Integrations → *Allowed workspaces*, `PUT /v1/settings/vault/allowlist` with `{workspaceIds, serviceIds?}`) governs every other kind too, Parameter Store and exec included. The credentials are instance-wide, so only services owned by an operator, or tagged into an allowed workspace, may use them. Also allowed: a service linked (through a trustworthy project link) to a project whose workspace is allowed, and a service grandfathered by id (last bullet).

- **Writes:** a non-operator cannot save an env value containing a reference unless the service's workspace is allowed (403). The gate runs on the env routes (`POST /v1/services/:id/env`, `PATCH /v1/services/:id/env/:varId`, `POST /v1/services/:id/env/import`, `POST /v1/projects/:id/env` and `PATCH /v1/projects/:id/env/:varId`, where a project is judged by its own workspace), on a template deploy and on a service-bundle import. Operators pass untouched.
- **Deploys:** a service that is not allowed fails its deploy with an actionable message. The check runs once, before the first secret is fetched.
- **PR previews** never receive a referenced value. At a preview deploy every env key whose value holds a reference is **dropped**, so the app sees it as unset, and the deploy log lists it under "withheld from this preview's environment". The preview-only environment (`POST` and `PATCH /v1/services/:id/env/preview`) refuses a reference at write time with 400, for operators as well.
- The allowlist that was seeded from existing usage when it was introduced (r510) grandfathered only services that used Infisical or Doppler references: text of the other shapes never resolved on those releases, so it seeded nothing. An entry the seed did write (a workspace or a service id) is not limited to those two providers; it allows every kind for that workspace or service.

---

## 5. Behaviour and limits at deploy time

References resolve when the deploy assembles the service's runtime environment (`loadRuntimeEnv` in `engine/pipeline.ts`), last, from the fully merged map: project-shared values, then the service's own values, then preview-only values and attached databases. The same resolution runs again for the pre-stop hook's environment. Only environment values take references; a reference anywhere else (a build setting, a domain, a label) is ordinary text.

- Each distinct Vault path, AWS secret, Parameter Store name or GCP, Azure, 1Password or exec name is fetched **once per deploy**, however many env keys reference it (two keys of one JSON secret are one fetch).
- At most **100** distinct external references per deploy, of all kinds together, **15 seconds** per provider call, **60 seconds** for all of a deploy's calls together, and **64 KiB** per resolved value.
- A key whose value holds a reference counts as a **secret** for the rest of the deploy even when it is not marked secret: its resolved value is masked in the deploy log.
- A missing field or JSON key, an unreachable provider or a refused credential **fails the deploy**. A half-resolved secret leaking the raw reference into a container would be worse.
- Every call goes through the egress guard: DNS is resolved and pinned, private, loopback and link-local addresses are refused unless `NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1`, and a redirect is an error, never followed.
- Error messages never contain the token, key, secret id or path; provider response bodies are cut to 200 characters.

The panel does not persist a resolved value, but it is not secret from the Docker host: on the panel host it is written to a temporary env file (mode 0600, in a private directory, removed once the container has started), on a node it travels sealed and is written under the agent's `.agent-env` directory, and from then on it sits in the container's own configuration, where `docker inspect` shows it like any other environment variable.

---

## 6. Literal until configured

A `${{vault:…}}` or `${{aws:…}}` reference whose provider is **not configured** (no provider saved, the provider is disabled, or its stored credentials cannot be decrypted with the current master key) **stays literal**. The container receives the text `${{vault:…}}` unchanged, and the deploy log warns, naming the env keys (never the values). This is exactly what every release before 0.14 did with such a string, so an install that already had text of this shape deploys byte for byte as before.

Two things do change for such strings from 0.14 on: a non-operator's write is subject to the allowlist, and PR previews withhold them. Both are fail-safe.

Infisical and Doppler keep their old behaviour: a reference to one of them while it is not configured fails the deploy. Deleting a Vault or AWS provider (`DELETE /v1/settings/secret-providers/<kind>`) turns its references back into literal text at the next deploy.

---

## 7. Management API

All routes are operator-only: an interactive operator session, or an API token that carries the coarse `operator` scope. A token holding only `read`, `write` or fine-grained scopes (such as `nd://scope/write/settings`) loses the operator flag and is refused.

| Route | Purpose |
| :--- | :--- |
| `GET /v1/settings/secret-providers` | `[{kind, configured, enabled, config, hasCredential, lastTestedAt, lastTestError}]`, one entry for each of `vault`, `aws`, `gcp`, `azure`, `onepassword` and `exec` in that order, whether saved or not. Credentials are never returned. |
| `PUT /v1/settings/secret-providers/<kind>` | Save. An omitted credential field keeps the stored value, unless the save replaces what the stored credential belongs to: a different auth method, a new AppRole role id, a new access key id, or a different destination for the credential (the Vault `address`, a custom Secrets Manager `endpoint`, the 1Password Connect `address`; for Azure the `tenantId`, `clientId` or `vaultUrl`). Each of those must come with its own secret, so a stored credential is never sent to a server it was not entered for. `enabled` defaults to `true`, or keeps the stored value on an existing row. Saving clears the last test result. |
| `DELETE /v1/settings/secret-providers/<kind>` | Remove (`{ok, deleted}`). References become literal again. |
| `POST /v1/settings/secret-providers/<kind>/test` | `{ok, detail}`; probes `probePath` (vault), `probeSecretId` / `probeParameter` (aws), `probeName` (the others). A probe field that belongs to another kind is a 400. Records `lastTestedAt` and `lastTestError` only. |

A bad address, region, key id or role ARN is a 400 at save time, not a failed deploy later, and so is an incomplete credential set. Saves and deletions are audited as `settings.secret_provider.save` and `settings.secret_provider.delete`, with the kind and switches only, never an address path or a credential. The credentials are one encrypted envelope (`secret_providers.credential_encrypted`), re-encrypted by master-key rotation like every other secret.

In the SDK the same four calls are `client.settings.secretProviders.list()`, `.set(kind, input)`, `.delete(kind)` and `.test(kind, probe)`.

---

## 8. Rolling back to 0.13

0.13 ignores the `secret_providers` table and does not know the new reference forms. A container deployed on 0.13 therefore receives the **literal reference string**. Nothing leaks, but the app is misconfigured. Before rolling back, move the affected values into ordinary secret env vars (or into Infisical or Doppler), or redeploy only after upgrading again. The stored provider settings survive a rollback and work again after the next upgrade. See [ROLLBACK.md](./ROLLBACK.md).
