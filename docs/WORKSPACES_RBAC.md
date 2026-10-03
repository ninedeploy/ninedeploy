# Workspaces & Role-Based Access Control (RBAC)

NineDeploy provides multi-tenant Workspaces, allowing engineering organizations to partition services, databases, secrets, and servers into isolated scopes with team access controls.

---

## 🏢 1. Workspace Scoping

Every resource in NineDeploy belongs to a Workspace:
- **Services & Containers**
- **Managed Databases & Volumes**
- **Domains & SSL Certificates**
- **Secrets & Environment Variables**
- **Connected Servers & Remote Agents**

Users can seamlessly switch between Workspaces from the dashboard header or CLI without re-authenticating.

---

## 👥 2. Role Hierarchy & Permission Matrix

NineDeploy has four role levels **within each workspace**, plus one flag that
sits outside the workspace model entirely (see §2.1).

Roles rank `owner > admin > member > viewer`. On a service, your effective role
is the **highest seat you hold across the workspaces that service is tagged
into**; being the service's creator, or an instance operator, counts as `owner`.

| Permission | Owner | Admin | Member | Viewer |
| :--- | :---: | :---: | :---: | :---: |
| Transfer / delete the workspace | ✅ | ❌ | ❌ | ❌ |
| Workspace settings (name, slug, description) | ✅ | ✅ | ❌ | ❌ |
| Invite, remove and re-role members | ✅ | ✅ | ❌ | ❌ |
| Delete a service · re-tag it into other workspaces | ✅ | ✅ | ❌ | ❌ |
| Create services · edit service & build config · set limits | ✅ | ✅ | ✅ | ❌ |
| Trigger deploys, rollbacks, cancels · start/stop/restart | ✅ | ✅ | ✅ | ❌ |
| Edit environment variables · manage domains | ✅ | ✅ | ✅ | ❌ |
| View the dashboard, services, metrics, deploy logs | ✅ | ✅ | ✅ | ✅ |

Enforcement lives in `assertServiceRole` (`apps/server/src/lib/resourceAccess.ts`)
and is covered by `apps/server/test/workspaceRoleEnforcement.test.ts`.

Managed databases follow the same hierarchy through `assertDatabaseRole`; a
database's workspace is the one its **project** belongs to:

| Permission | Owner | Admin | Member | Viewer |
| :--- | :---: | :---: | :---: | :---: |
| Delete the database · take/restore a backup · reveal credentials | ✅ | ✅ | ❌ | ❌ |
| Start / stop / restart · change CPU & memory limits | ✅ | ✅ | ✅ | ❌ |
| View the database, its size, backups and logs | ✅ | ✅ | ✅ | ✅ |

> **Two deliberate exceptions** stay instance-operator-only whatever your
> workspace role, because they reach past the workspace boundary:
> **database Studio** (it binds a port on the host) and **volume-scope
> backups** (they belong to no database, so there is no workspace to derive a
> role from).

> **Still panel/operator-only:** log drains and instance settings. Tracked in
> ARCHITECTURE.md §16.4.

### 2.1 Instance operator — not a workspace role

A separate flag, `users.is_instance_operator`, controls everything that is not
scoped to a workspace:

- managing users, SSO/OIDC providers and instance settings
- system export/import, the self-updater, host firewall rules
- the container file browser, `docker exec`, volume deletion
- **host-privileged deploys**: PM2 services, Compose stacks, deploy lifecycle
  hooks and Docker-socket templates all execute code on the host itself

Rules:

1. The **first** account on a fresh instance receives it (`/setup`, the first
   `/auth/register`, or the first SSO auto-enrolment).
2. Everyone else must be granted it by an existing operator — Settings → Users →
   *Make operator*, or `PATCH /v1/users/:id/operator`.
3. **Creating a workspace does not confer it.** Before 0.3.5 the flag was
   inferred from holding `owner`/`admin` in any workspace, and since any user
   can create a workspace they own, any user could self-promote to full instance
   control — including host code execution. Migration `0038` moved the flag onto
   the user row to close that path.
4. The last remaining operator cannot be demoted or deleted.

On upgrade, the flag is backfilled to the bootstrap user and to the
owners/admins of the **oldest** workspace only. If someone legitimately needs it
and was missed, an existing operator re-grants it from Settings → Users.

### 2.2 API tokens

API tokens carry scopes, enforced on every request:

| Scope | Effect |
| :--- | :--- |
| `read` | safe methods only (`GET`/`HEAD`/`OPTIONS`) |
| `write` | any method, but the request always runs as a **non-operator** |
| `operator` | no extra restriction beyond the owner's own authority |

A scope can only ever narrow what the owning account can do — asking for
`operator` as a non-operator is refused at creation. Tokens created before 0.3.5
have an empty scope list, which still means *unrestricted*; `ninedeploy token
list` labels those, and re-issuing them with an explicit scope is recommended
(a `write`-scoped CI token cannot reach the host-privileged deploy paths).

---

## ✉️ 3. Team Invitations & Member Management

1. **Invite Links**: Admins generate time-limited invitation tokens or send direct email invites.
2. **Role Assignment**: Assign appropriate roles upon invitation or update existing member privileges.
3. **Revocation**: Removing a member immediately revokes their workspace tokens and active sessions.
