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
| `ctx.emit(event, payload)` | Emit on the panel's event bus — **only** names of the form `plugin.<your plugin id>.<name>` (type `PluginEventName`). Anything else is dropped, logged once and audited once (`plugin.event_rejected`); kernel events (`audit.recorded`, `deployment.status_changed`, …) cannot be emitted by a plugin. |
| `ctx.on(event, handler)` | Observe panel events and other plugins' `plugin.<id>.*` events. Secret-bearing fields arrive as `"[redacted]"` (see below). |
| `ctx.tapHook(name, fn, { priority })` | Intercept deploy pipelines etc. Only `priority` is honoured — the host applies its own 5 s per-tap budget and rejection-based rollback; per-tap `rollback`/`timeoutMs`/`id` options do not exist (r473 removed the phantom type declarations). |
| lifecycle `init(ctx)` / `destroy()` | The only lifecycle hooks the runtime calls. There are no `start`/`stop` hooks (r473). |

## Honest contract notes

- Declaring `configSchema`/`menuItems`/`dependencies` **on the returned object** registers them (r473). Before r473 only the install manifest was read — code written against older examples silently dropped these.
- A plugin cannot read the filesystem, spawn processes, or reach the panel's environment; installing a plugin remains a trust decision about what it may do THROUGH this API.
- **Event namespace (0.10.36):** `ctx.emit` accepts only `plugin.<id>.<name>`. Code that emitted any other name (e.g. `custom.system_event`, `my.thing`) now has those emits dropped with a one-time warning in the panel log — rename them to `` `plugin.${ctx.pluginId}.my_thing` ``. Panel listeners never treat a plugin emission as a kernel event.
- **Redaction (0.10.36):** hook payloads and relayed events cross into the sandbox with these fields replaced by `"[redacted]"`, matched by key name at any depth: anything named like a password/passphrase, secret, token, API key, private key, credential(s), htpasswd, basicAuth, authorization, cookie or master key (e.g. `passwordEncrypted`, `verificationToken`, `basicAuth`, the server-announce `token`); `env`/`envVars`/`environment` **objects**; `composeContent`; and the userinfo of any URL (`https://[redacted]@github.com/…` for a `repoUrl` with credentials). Booleans, numbers and empty values are left alone (`isSecret: true` stays readable). Returning the payload from a hook keeps the real values on the panel side; only fields you change take effect.
- **Plugin ids (0.10.36):** a sandbox id must match `^[a-z0-9][a-z0-9_-]{0,63}$` (case-insensitive) and may not be a built-in plugin id or a marketplace catalog id — `:` and `.` would reach into another plugin's config / event namespace.
- **Network:** on Node ≥ 25 (the official Docker image runs Node 26) the permission model denies network access too — `fetch`/sockets/DNS from a sandbox plugin fail with `ERR_ACCESS_DENIED`; the panel never passes `--allow-net`. On Node 22/24 (bare-metal installs at the `engines` floor) the permission model has no network scope and a plugin CAN reach the network. There is no per-plugin network grant.
