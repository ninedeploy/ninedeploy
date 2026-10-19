# Uptime monitors and status pages (0.16.8)

NineDeploy can check your sites and ports from the panel host and tell you when one goes down. It can also publish a public status page that shows those checks to your users. Nothing runs until an operator creates a monitor, so an upgraded panel behaves as before.

## Monitors

A monitor checks one target on an interval:

| Kind | Target | It passes when |
| --- | --- | --- |
| `http` | an `http://` or `https://` URL | the response status is one of the expected codes (default `200-399`), and the body contains the keyword, if one is set |
| `tcp` | `host:port` (an IPv6 address in brackets) | the connection opens |

Settings:

- **Interval:** 30 s to 1 h (default 60 s).
- **Timeout:** 1–60 s (default 10 s). For HTTP it covers the whole request, redirects included.
- **Failures before down:** 1–10 (default 2). This many failed checks in a row turn the monitor down; one success turns it up again.
- **HTTP options:**
  - method `GET` or `HEAD`;
  - expected codes as a list of codes and ranges (`200,204,301-302`);
  - a keyword searched in the first 1 MiB of the body (`GET` only);
  - follow redirects (up to 5, http and https only);
  - verify TLS (turn off for a self-signed certificate).
- **Service:** optional. A monitor attached to a service is visible to everyone who can see that service. One without a service is visible to operators only.

Checks run from the panel host, so a target can be a private address, such as a database on the LAN or a container port on the host. Monitors are operator configuration, like alert rules: operators create and change them, and members read the ones on their services.

**What is recorded for each monitor:**
- each check, kept 7 days;
- a daily rollup, kept 400 days;
- its last response time, status code and error;
- for HTTPS, when the certificate expires.

The API returns 24-hour, 7-day and 30-day uptime.

### Notifications

When a monitor goes down, NineDeploy records the event `alert.monitor_down`, with the reason, for example `API #3: status 503 (expected 200-399)`. When it recovers, it records `alert.monitor_up`, with how long it was down. Both are delivered like every other alert:

- to the notification channels whose event filter matches (`alert.`, `alert.monitor_down`, or everything);
- to the `alert` subscriptions of the monitor's service.

A monitor that is already down does not notify again until it has recovered.

## Status pages

A status page is a public page at `https://<panel>/status/<slug>`. For each monitor you choose, it shows:

- the name;
- the current state;
- the uptime over 90 days, with one bar per day;
- the average response time, unless the page hides it.

It never shows a monitor's target, error text or service. The page:

- has no scripts and no external assets;
- reloads itself every 60 s;
- follows the visitor's light or dark setting.

The same data is available as JSON at `GET /v1/status/<slug>`. Both are cached for 30 s.

A page answers 404 until it is **published**. An unpublished page and an unknown slug get the same answer. Use **notice** for a maintenance window or an incident; it shows at the top of the page.

The status page is served by the panel. To put it on its own hostname, point that hostname at the panel the same way as the panel's own domain.

## API, CLI and SDK

| | |
| --- | --- |
| `GET /v1/monitors` (`?serviceId=`) | list, with state and uptime |
| `GET /v1/monitors/:id`, `GET /v1/monitors/:id/checks?hours=` | one monitor, and its checks (1–168 h) |
| `POST /v1/monitors`, `PATCH /v1/monitors/:id`, `DELETE /v1/monitors/:id` | manage (operator) |
| `POST /v1/monitors/:id/check` | check now (operator); recorded like a scheduled check |
| `GET/POST /v1/status-pages`, `GET/PATCH/DELETE /v1/status-pages/:id` | manage status pages (operator) |
| `GET /v1/status/:slug` | a published page as JSON (no session) |
| `GET /status/:slug` | a published page as HTML (no session) |

- **CLI:** `ninedeploy monitors list|add|show|check|pause|resume|rm` and `ninedeploy status-pages list|add|publish|unpublish|notice|rm`.
- **SDK:** `client.monitors` and `client.statusPages`.
- **MCP:** the read-only tool `list_monitors`.

## Limits

- Checks run from the panel host only. A node does not check anything, so a monitor tells you whether the target can be reached from the panel.
- At most 20 checks run at once. A monitor is never checked twice at the same time.
- A status page shows at most 50 monitors.
