# Instance GitOps (G5.3)

One YAML file in a git repository describes the instance:

- its projects,
- their services (identity and source),
- their domains,
- their project grants.

The panel compares the file with the instance on a schedule and shows the drift. When the drift changes, it raises an alert. On request it applies the file through the ordinary API.

It is set up under **Settings → GitOps** by an operator, or through `/v1/gitops`.

## The file

```yaml
version: "1"
projects:
  - slug: shop
    name: Shop
    workspace: main          # workspace slug; optional
    description: The web shop
    services:
      - slug: api
        name: api
        type: docker         # docker | compose
        image: ghcr.io/acme/api:1.4.2
        port: 3000
        domains: [api.shop.example.com]
      - slug: web
        repoUrl: https://github.com/acme/web
        branch: main
        domains: [shop.example.com]
    grants:
      - { email: bob@example.com, role: admin }   # viewer | member | admin
```

**Managed fields**
- A service field you leave out is not managed: the panel keeps whatever it has.
- Domains are hostnames on path `/`.
- Grants are project grants (no environment).

**Validation**
- The file is limited to 256 KiB and must use the schema exactly; unknown keys are refused.
- Each project slug, service slug, domain and grant may appear only once.
- The secret scanner of the service manifest runs over the file. Secrets and environment values stay in the panel.

**Reading the file**
- The panel reads the file from a shallow checkout of the configured branch, with the same egress rules as a deploy checkout.
- For a private repository, pick a git source; its credential is used for the checkout.
- A path that resolves outside the checkout, for example through a symlink, is refused.

## Drift

Each difference is one of three kinds:

| Change | Meaning |
| :--- | :--- |
| `missing` | In the file, not in the instance. |
| `extra` | In the instance, not in the file. Covers projects the file does not name, and services, domains and grants of the projects it does name. |
| `changed` | In both, with different fields. Each changed field shows the value in the instance and the value in the file. |

**When the panel checks**
- Every *interval* minutes while scheduled checks are on.
- Whenever someone presses **Check now** (`POST /v1/gitops/check`).

**Alerts**
- A drift that differs from the previous check is audited as `alert.gitops_drift`.
- A file that cannot be read is audited as `alert.gitops_failed`. It is raised once, until a read succeeds again.
- Both reach the channels that receive alerts, including PagerDuty and Opsgenie as warnings.

## Applying

**Apply the file** (`POST /v1/gitops/apply`) reads the file again and calls the ordinary routes with the operator's own credentials, in this order:

1. Projects are created or updated: name, description and workspace.
2. Services are created in their project, or their managed fields are patched.
3. Domains are added.
4. Project grants are created, or their role is changed.

Every check those routes make still applies: slug rules, image policy, domain ownership and grant caps. A refused step is reported with its reason, and the other steps still run.

Applying never deletes. `extra` items stay until someone removes them in the panel.

A service whose slug belongs to a service outside the project is reported and left alone.

## Write-back

To bring edits made in the panel back to the repository:

1. Export the panel as the file: **Export the panel as the file**, or `GET /v1/gitops/export` (YAML; `?format=json` answers `{ file }`).
2. Commit the result.

The panel does not push to the repository itself. It holds no write credential for it.

## Storage

The configuration and the last check are settings rows (`instance_gitops`, `instance_gitops_check`). There is no migration.
