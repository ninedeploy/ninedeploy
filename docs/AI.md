# AI assistant

NineDeploy can ask an AI model about a service: why a build failed, what a running service's logs say, and which `.ninedeploy` manifest fits an app you describe. It brings no model of its own. The instance operator configures one provider, a model and an API key, and every AI feature uses that configuration.

## Providers (0.16.15)

**Settings → AI assistant**, operator only. The key is sent once, stored encrypted, and never returned by any route.

| Provider | Calls | Base URL | Example models |
|---|---|---|---|
| **Claude (Anthropic)** | `POST <base>/v1/messages`, with `x-api-key` and `anthropic-version: 2023-06-01` | Optional; empty means `https://api.anthropic.com`. A gateway that speaks the Messages API works too. | `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5` |
| **OpenAI-compatible** | `POST <base>/chat/completions`, with a bearer token | Required: OpenAI, a gateway, or a local Ollama or LM Studio | `gpt-4o-mini`, `llama3.1` |

A configuration saved before 0.16.15 has no provider and keeps working as OpenAI-compatible.

API: `GET /v1/ai/config` (any signed-in user; no key material, and the base URL for operators only). `PUT /v1/ai/config` takes `{ provider?, baseUrl?, model, apiKey? }` (operator). SDK: `ai.getConfig`, `ai.updateConfig`.

## Who may use it

Every call spends the operator's key, so:
- only instance operators and members of a workspace an instance operator owns may use it; a seat in a workspace you created for yourself does not count;
- a diagnosis or a log analysis also needs `member` on the service;
- a protected lane's logs are for its admins only ([DEPLOYMENTS.md](DEPLOYMENTS.md#protected-lanes-and-deploy-approvals-01613));
- each feature is limited to 10 calls a minute.

## What leaves the panel

Logs are sanitized before they are sent:
- ANSI codes are removed;
- passwords in URLs, `Authorization` headers and bearer tokens are masked;
- so is the value of every assignment whose name says it is a credential (`…PASSWORD=`, `…TOKEN=`, `…SECRET=`, `--password`, …).

Only the last 16 KB is sent. The sanitizer is a safety net: a build log is still output from your own code, so choose a provider you trust with it. Each call is audited (`ai.diagnose`, `ai.analyze_logs`, `ai.suggest`).

## Failed-deploy diagnosis

On a failed deployment, **Service → Deploys → AI diagnosis** sends the build log's tail. The answer has three parts: the root cause, the decisive log lines, and numbered fix steps.

API: `POST /v1/ai/services/:id/deploys/:depId/diagnose`. SDK: `ai.diagnose`.

## Runtime-log analysis (0.16.15)

On a running service, open **Runtime logs** on the service page and press **Analyze**. It sends the newest lines you are looking at (300, 1,000 or 5,000). The answer has three parts:
- **Health:** healthy, degraded or failing.
- **Problems:** each one with its log lines quoted and its likely cause.
- **Next steps:** what to do.

It is told not to invent problems the logs do not show. Still, an analysis can be wrong, so check the quoted lines before acting.

- **API:** `POST /v1/ai/services/:id/logs/analyze` with `{ tail? }` (20–5000, default 300).
  - It answers `{ analysis, model, lines }`.
  - `400 not_running` when the service has no runtime; `400 no_logs` when it has written nothing.
- **SDK:** `ai.analyzeLogs(serviceId, { tail })`.
- **CLI:** `ninedeploy logs analyze <service> [--tail <n>] [--json]`.

## Manifest suggestions

In the manifest creator, describe the app in plain words and get a `.ninedeploy` manifest back. The model's answer is checked against the strict manifest schema before you see it, so it cannot add fields that do not exist.

API: `POST /v1/ai/suggest-manifest`. SDK: `ai.suggestManifest`.
