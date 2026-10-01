# @ninedeploy/plugin-sdk

Types and helpers for authoring **NineDeploy sandbox plugins** — third-party code the panel runs inside a permission-model child process (r468: no filesystem, child processes, worker threads or native addons; a scrubbed environment; memory caps).

## The two halves of a plugin

A plugin install carries **code** and, optionally, a **manifest**:

- **`code`** is an async function BODY, not a module: the sandbox evaluates it as `new AsyncFunction('require', 'ctx', code)` — no `import`/`export` statements, no `require` (it is `undefined`), and the only panel surface it can touch is the `ctx` it is handed. Bundle your TypeScript before install. See `examples/custom-notifier/plugin-body.txt` for the exact shape.
- The returned object is the plugin **definition** (`id`, `name`, `version`, `configSchema`, `menuItems`, `dependencies`). Everything declared there is honoured by the panel when the plugin reports READY (r473) — the install manifest's copies of those fields are the fallback.

`definePlugin(...)` (from this package, used at build time in your bundler's typecheck) validates the definition shape before you ship it.

## The ctx surface (what actually exists at runtime)

| Member | Behaviour |
| --- | --- |
| `ctx.config.get / getSecret / set / delete` | Namespaced config storage; `getSecret` reads secret-scoped values. |
| `ctx.logger.debug/info/warn/error(message, ...args)` | Extra args are stringified into the panel log (r473). |
| `ctx.emit(event, payload)` / `ctx.on(event, handler)` | The panel's event bus, namespaced per plugin. |
| `ctx.tapHook(name, fn, { priority })` | Intercept deploy pipelines etc. Only `priority` is honoured — the host applies its own 5 s per-tap budget and rejection-based rollback; per-tap `rollback`/`timeoutMs`/`id` options do not exist (r473 removed the phantom type declarations). |
| lifecycle `init(ctx)` / `destroy()` | The only lifecycle hooks the runtime calls. There are no `start`/`stop` hooks (r473). |

## Honest contract notes

- Declaring `configSchema`/`menuItems`/`dependencies` **on the returned object** registers them (r473). Before r473 only the install manifest was read — code written against older examples silently dropped these.
- A plugin cannot read the filesystem, spawn processes, or reach the panel's environment; installing a plugin remains a trust decision about what it may do THROUGH this API.
