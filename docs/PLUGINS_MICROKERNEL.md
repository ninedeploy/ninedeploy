# Plugins SDK & Microkernel Architecture

NineDeploy features an extensible Microkernel architecture allowing developers to hook into the deployment lifecycle, register custom UI navigation menus, and swap core driver implementations.

---

## 🔌 1. Kernel Events & Waterfall Hooks

The kernel exposes two integration surfaces: a typed **event bus** (`ctx.events.on`) for observing lifecycle activity, and sequential **waterfall hooks** (`ctx.tapHook`) that can inspect — and in some cases abort or amend — pipeline steps.

### Events (`events.on(event, handler)`)

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
    });
    const untap = ctx.tapHook(
      'deploy:before',
      async (payload) => {
        // Inspect or amend deployment payload
        return payload;
      },
      {
        priority: 150,
        rollback: async (payload, error) => {
          // Saga Rollback: cleanup provisioned sidecar or resources if a downstream hook fails
          console.log(`Rolling back deployment hook due to: ${error?.message}`);
        },
      },
    );
    void untap;
  },
});
```

The official plugins shipped in-tree are the reference implementations for the
event and hook APIs.

### 🛡️ 2. Isolated Worker Thread Sandboxing

NineDeploy executes third-party community extensions in dedicated `node:worker_threads` isolates with memory limits and an asynchronous RPC bridge:

- **Memory Limits**: Isolated workers are constrained by V8 generation size bounds (`maxYoungGenerationSizeMb: 16`, `maxOldGenerationSizeMb: 64`).
- **Crash Isolation**: If an external plugin throws a fatal exception or crashes its worker, the NineDeploy core API and database remain unaffected. The kernel flags the plugin state as `errored` and continues running.
- **Scoped RPC Bridge**: Sandboxed plugins interact through `PluginContext` APIs (`events.on`, `tapHook`, `scopedConfig.get/set`); the bridge namespaces config access per plugin id.
- **Honesty note (r414)**: this is resource containment, NOT a security sandbox. The worker runs with a scrubbed environment (no `NINEDEPLOY_MASTER_KEY`/JWT secrets — a worker thread otherwise inherits a copy of the panel's env), but its code can still dynamically import Node builtins and read files the panel user can read. Installing any third-party plugin — sandboxed or not — is an operator-level trust decision, exactly like a PM2 service or a lifecycle hook, and the install route is admin-gated accordingly.

### 🗂️ 3. Dynamic UI Menus, Widgets & Driver Registries

- **Menu & Widget Slots**: Inject custom navigation tabs and live dashboard widgets:
  - `sidebar:main`, `sidebar:secondary`: Sidebar navigation
  - `dashboard:overview`: Live dashboard telemetry & overview cards
  - `service:tabs`, `service:overview:widget`: Service-level inspection panels
  - `command:palette`: Global command search items
- **ServiceRegistry**: Interchange core storage, DNS (Cloudflare, DNSimple, Namecheap), orchestrator, and deploy drivers dynamically at runtime.
- **ConfigCenter Integration**: Read and persist encrypted plugin configurations in the central key-value store.

