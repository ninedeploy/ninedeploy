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
From 0.15 a project or environment grant can raise that role, never lower it
(§2.3).

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

### 2.3 Project and environment access grants (0.15)

A grant gives one user a role on part of a workspace: a project, an
environment, or both. Grants are **raise-only**:

```text
effective role on a resource = max(seat role in the resource's workspace(s),
                                   highest role of the user's matching grants)
```

- A grant never lowers a role. To keep a seat admin to `viewer` on
  production, give the seat `viewer` and grant `member` or `admin` on the
  other environments.
- `owner` is never grantable. Operators stay `owner` everywhere.
- With no grants, every permission is exactly what it was in 0.14 (proven
  over 4839 access decisions by `test/accessGrantsEquivalence.test.ts`). A
  grant only ever adds access, for its one user.

**What a grant covers**

| Grant | Covers |
| :--- | :--- |
| Project P | The project itself, the databases in P, and the services linked to P |
| Environment E | The services whose environment is E |
| Project P + environment E | The services linked to P **and** in E. Not the project row, and not P's databases |

Databases have no environment, so an environment grant never covers one.
Every grant also requires the service to be **tagged into the grant's
workspace**: a project link alone never reaches another workspace's service,
even when someone linked that service to this workspace's project. A grant's
project and environment must belong to the grant's workspace; a project moved
to another workspace stops matching its old grants at once, and the move
deletes them.

**Guests.** A user with grants in a workspace but no seat there is a guest. A
guest sees only the granted projects, environments and the resources they
cover, and works on them within the granted role. A guest gets no
workspace-level right: member lists, invitations, labels, email templates,
creating projects and workspace settings all stay refused, as for any
non-member, and probing a resource that is not granted answers 404. In 0.15
guests cannot create services or databases, because new resources are tagged
by seat. `GET /v1/access/me` (`ninedeploy access me`) lists a user's own
grants and the workspaces they reach only through grants (`guestWorkspaces`);
the workspace list (`GET /v1/workspaces`) is unchanged and shows seats only.

**Who can grant**

- Workspace `admin`s and `owner`s, up to their own role capped at `admin`, and
  instance operators (up to `admin`). A grant above your cap answers 403
  `grant_exceeds_role`.
- An admin can grant only to an account they already share a workspace with,
  or that already holds a grant in this workspace. Any other email answers the
  same 404 as an unknown one, so the route cannot be used to find out which
  emails have accounts. Operators can grant to any account.
- One grant per user and target (a duplicate is 409); change its role instead.

Manage grants in Workspaces → Access grants, with `ninedeploy access grants
list|add|update|remove`, or `GET/POST /v1/workspaces/:wid/access-grants` and
`PATCH/DELETE /v1/workspaces/:wid/access-grants/:grantId`. `GET
/v1/projects/:id/access` (project admin) lists everyone who reaches a project
and how (`operator`, `seat`, `grant`). The grant routes have no fine-grained
token scope; the read-only MCP tools `list_access_grants` and `my_access` need
a coarse token. Every write is audited as `workspace.access_grant.create`,
`.update`, `.delete`, `.suspend` or `.reinstate`.

**Suspending a grant.** `PATCH …/access-grants/:grantId {"suspended": true}`
(CLI `--suspend`) keeps the grant listed but stops it counting on the next
request; `{"suspended": false}` (`--reinstate`) makes it count again. The
workspace admin's hold and the identity provider's hold are kept separately,
and a grant is suspended while either exists.

**Lifecycle with seats and SCIM**

- Removing a member from a workspace deletes their grants there, so they do
  not stay behind as a guest.
- SCIM deactivation in a workspace puts an IdP hold on the user's grants
  there; SCIM re-activation lifts it (a grant an admin also suspended stays
  suspended). Only SCIM lifts an IdP hold: an admin reinstate answers 409
  `grant_suspended_by_idp` while it stands or while the user is SCIM-suspended
  in the workspace, and a new grant for such a user answers 409
  `user_suspended_by_idp`. A SCIM delete removes the user's grants.
- Deleting the user, the workspace, the project or the environment deletes the
  grant. A deactivated account reaches nothing.

**Rolling back to 0.14** ignores the `access_grants` table, so every effect is
a loss of access: guests lose everything and elevated roles fall back to the
seat role. Tell guests before you roll back. See [ROLLBACK.md](./ROLLBACK.md).

---

## ✉️ 3. Team Invitations & Member Management

1. **Invite Links**: Admins generate time-limited invitation tokens or send direct email invites.
2. **Role Assignment**: Assign appropriate roles upon invitation or update existing member privileges.
3. **Revocation**: Removing a member immediately revokes their workspace tokens and active sessions.
