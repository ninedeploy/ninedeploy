# Plugins SDK & Microkernel Architecture

NineDeploy features an extensible Microkernel architecture allowing developers to hook into the deployment lifecycle, register custom UI navigation menus, and swap core driver implementations.

---

## 🔌 1. Kernel Events & Waterfall Hooks

The kernel exposes two integration surfaces: a typed **event bus** (`ctx.on`) for observing lifecycle activity, and sequential **waterfall hooks** (`ctx.tapHook`) that can inspect — and in some cases abort or amend — pipeline steps.

### Events (`ctx.on(event, handler)`)

The bus is fed from the application's audit stream — every `audit()` call, which
is the one choke point each meaningful state change already passes through (see
`kernel/auditBridge.ts`). These events **fire today**:

| Event | Source |
| :--- | :--- |
| `audit.recorded` | Every audit entry, raw: `{ action, entity, actorUserId, ts }`. Subscribe here for anything the table below does not cover. |
| `deployment.status_changed` | Bridged from `deploy.*` (start / success / failed / rollback / cancel) |
| `service.health_changed` | Bridged from `service.start` / `stop` / `restart` |
| `backup.completed` | Bridged from `backup.create` |
| `alert.triggered` | Bridged from `alert.fired` / `alert.recovered` |
| `plugin.registered`, `plugin.reloaded`, `plugin.status_changed` | Kernel lifecycle |
| `notification.queued` | Emitted by the built-in notifications plugin as an **extension point**. It is not the delivery path: `lib/notifier` owns channels, retries and the delivery log, so consuming this and sending would double every alert. |
| `telemetry.recorded`, `tunnel.route_evaluated` | Built-in telemetry / Cloudflare-tunnel plugins |

**Emitting (r530).** A sandboxed plugin may only emit events in its own
namespace, `plugin.<pluginId>.<name>` (e.g. `plugin.acme-notifier.synced`).
Any other name is dropped, logged once per name and audited once per load as
`plugin.event_rejected` — a plugin cannot forge `audit.recorded`,
`deployment.status_changed`, `alert.triggered`, `telemetry.recorded` or any
other kernel event. Emissions are tagged host-side with
`{ kind: 'plugin', pluginId }` (`EventOrigin` in `kernel/types.ts`); the bus
never hands a plugin-origin emission to a typed `events.on(...)` listener, and
an exact-name `events.onCustom(...)` listener receives one only when it opts in
with `{ acceptPluginOrigin: true }`. Wildcard (`'*'`) listeners see everything
and get the origin as their third argument — the telemetry streamer drops
plugin-origin events there. Built-in plugins therefore only ever act on
kernel/audit-bridge events.

`DomainEvents` in `kernel/types.ts` declares more names than this
(`service.created`, `database.created`, `server.announced`, `config.changed`, …).
They are typed for forward compatibility but **nothing emits them yet** — use
`audit.recorded` and match on `action` if you need one of those today.

### Sequential hooks (`tapHook(name, fn)`)

| Hook Name | Lifecycle Trigger | Capabilities |
| :--- | :--- | :--- |
| `deploy:before` | Prior to build/clone | Inspect the service/target commit; abort deployments |
| `deploy:build_complete` | Image built | Observe image tag & build duration |
| `deploy:healthcheck` | After health probe | React to healthy/unhealthy candidates |
| `deploy:after` | Post-switchover | Send custom Slack/Discord alerts, trigger webhooks |
| `database:before_delete` | Before a database removal | Veto via `allowOrAbort` |
| `database:after_create` | New database provisioned | Provision sidecars, seed data |
| `proxy:sync_routes` | Traefik route sync | Inspect the resolved domains/services |
| `server:before_announce` | Agent enrolment | Validate/reject joining nodes |

```typescript
import { definePlugin } from '@ninedeploy/plugin-sdk';

export default definePlugin({
  id: 'my-custom-hook',
  name: 'Custom Hook Plugin',
  version: '1.0.0',
  init(ctx) {
    // Pick an event from the "fires today" table above. `service.deployed` is
    // declared but not emitted yet — `deployment.status_changed` is its live
    // equivalent.
    ctx.on('deployment.status_changed', (payload) => {
      console.log(`Deployment ${payload.deploymentId} -> ${payload.status}`);
      // Your own events live under plugin.<your id>.* — nothing else is accepted.
      ctx.emit(`plugin.${ctx.pluginId}.deploy_seen`, { status: payload.status });
    });
    const untap = ctx.tapHook(
      'deploy:before',
      async (payload) => {
        // Inspect or amend deployment payload
        return payload;
      },
      // Only `priority` is honoured — the host applies its own per-tap
      // budget (5 s) and rejection-based rollback; per-tap rollback/
      // timeoutMs/id options do not exist (r473 removed the phantom types).
      { priority: 150 },
    );
    void untap;
  },
});
```

The official plugins shipped in-tree are the reference implementations for the
event and hook APIs.

### 🛡️ 2. Permission-Model Process Sandboxing (r468)

NineDeploy executes third-party community extensions in a dedicated **child process running under Node's permission model**, with an asynchronous RPC bridge:

- **Deny-by-default capabilities**: the sandbox process runs with `--permission` and exactly two fs-read allowlist entries (its own bootstrap directory and the package manifest the ESM loader needs). Filesystem read/write outside that, spawning child processes, opening worker threads and loading native addons are all denied by the runtime itself — a plugin that tries gets `ERR_ACCESS_DENIED`, not a warning. The classic exfiltration paths (read `master.key`/`.env`/the SQLite db, fork a shell) are physically closed.
- **Memory Limits**: the child runs with `--max-old-space-size=64` and `--max-semi-space-size=16` (the V8 generation-size equivalents of the old worker limits).
- **Crash Isolation**: if an external plugin throws a fatal exception or crashes its process, the NineDeploy core API and database remain unaffected. The kernel flags the plugin state as `errored` and continues running; a wedged child that ignores SIGTERM is SIGKILLed after a 3 s grace.
- **Scoped RPC Bridge**: sandboxed plugins interact through `PluginContext` APIs (`events.on`, `tapHook`, `scopedConfig.get/set`); the bridge namespaces config access (`plugin:<id>:`) and event emission (`plugin.<id>.`, r530) per plugin id.
- **Plugin ids (r531)**: a sandbox install must use an id matching `^[a-z0-9][a-z0-9_-]{0,63}$` (case-insensitive) that is neither a built-in plugin id (`notifications-dispatcher`, `domain-presets`, `webhook-out`, … — `BUILT_IN_PLUGIN_IDS` in `kernel/pluginLoader.ts`) nor a marketplace catalog id, and may not take over a row installed from a different source. A colliding install is refused with HTTP 409. A row that already collides from an older version is **skipped at boot** with the reason recorded on the row (status `errored`), the built-in keeps running, and enable/disable/reload answer 409 for it — uninstall removes just the stray row.
- **Secret redaction (r533)**: hook payloads and relayed events are copied before they cross the IPC boundary, with secret-bearing fields replaced by `"[redacted]"` — matched by key name at any depth (password/passphrase, secret, token, API key, private key, credential, htpasswd, basicAuth, authorization, cookie, master key — e.g. `databases.passwordEncrypted`, `domains.basicAuth`/`verificationToken`, the `server:before_announce` token), `env`/`envVars`/`environment` objects, `services.composeContent`, and URL userinfo (`repoUrl`). Ids, names, image, branch, commit, ports, status and hostnames pass through. A hook result that still holds a placeholder gets the original value back, so echoing the payload never leaks `[redacted]` into the pipeline.
- **Concurrent hook calls (r532)**: each invocation carries its own `callId` (echoed by the panel-shipped bootstrap), so two concurrent calls of one tap resolve independently.
- **Network (r534)**: not part of the flag set the panel controls. On Node ≥ 25 (`--allow-net` exists; the Docker image and CI run Node 26) `--permission` denies outbound connections, DNS and listening by default and the panel never passes `--allow-net` — a sandbox plugin has **no network**. On Node 22/24 (bare-metal installs at the `>=22.13` floor) the permission model has no network scope: a sandbox plugin **can** open sockets and `fetch`. Plugin manifests declare no capabilities, so there is no per-plugin grant; `SandboxPlugin.networkDenied()` reports which case the running Node is in.
- **Scrubbed environment (r414, carried over)**: `process.env` is not part of the permission model, so the child still gets only `PATH`/`LANG`/`TZ` — no `NINEDEPLOY_MASTER_KEY(S)`/JWT secret.
- **Remaining trust decision**: the sandboxed plugin can still DO everything its ctx APIs allow — read/write its own namespaced config (including secrets you store there), react to every event (redacted), and participate in deploy hooks. Installing a third-party plugin remains an operator-level trust decision about what it may do through the panel, exactly like granting it a limited API key; the boundary is that it can no longer reach around the API. The install route is admin-gated accordingly.

### 🗂️ 3. Dynamic UI Menus, Widgets & Driver Registries

- **Menu & Widget Slots**: Inject custom navigation tabs and live dashboard widgets:
  - `sidebar:main`, `sidebar:secondary`: Sidebar navigation
  - `dashboard:overview`: Live dashboard telemetry & overview cards
  - `service:tabs`, `service:overview:widget`: Service-level inspection panels
  - `command:palette`: Global command search items
- **ServiceRegistry**: Interchange core storage, DNS (Cloudflare, DNSimple, Namecheap), orchestrator, and deploy drivers dynamically at runtime.
- **ConfigCenter Integration**: Read and persist encrypted plugin configurations in the central key-value store.

