# Compact and classic layouts: the N10 acceptance record

Snapshot of November 23, 2026. This is the record of package **N10** in the [November 16 work plan](plans/PROJECT_REVIEW_2026-11-16.md#3-user-journeys-and-adoption): a comparison of the classic and compact panel layouts on the same operator and workspace-member tasks, the defects it found, and the decision it supports.

Starting state: local `main` at `841b2b270f6534e8fbf9525d66a46eede0f922fb`. Classic was the default and compact was opt-in under **Settings → Appearance → Layout**. The compact browser project repeated only the journeys that touch the service page (environment and rollback, approvals, the compact-only views, domain routing); first deploy, finding logs, backup and restore, team access and Turkish had never been measured in compact.

## How to repeat the comparison

The journeys run against one disposable panel. The compact projects repeat the desktop journeys on that same panel, each under its own service, database and member account, then walk the same pages at phone width.

```sh
PLAYWRIGHT_JSON_OUTPUT_FILE=$PWD/.temp_files/browser.json \
node scripts/smoke-browser-e2e.mjs --image=<candidate> -- \
  --project=setup --project=desktop --project=phone --project=desktop-compact --project=phone-compact \
  --reporter=list,json
```

Each N10 journey keeps what it measured as an attachment and an annotation named `n10-*` in the JSON report: clicks per task, the tabs and cards a layout hides, Tab stops, what each dialog does with the focus, unnamed controls, and the requests the page cost. `11-task-paths.spec.ts` holds the task matrix, `12-accessibility.spec.ts` the keyboard, focus, name and Turkish checks, and the N10 journeys in `phone.spec.ts` the phone drawer, tab strip, deep links and the member.

## The task matrix

Clicks from the dashboard to the control that starts each task, measured by the same walk in both layouts at 1366 × 900. The root page opens on the Organize group, so **Workspaces** is one click away there.

| Task | Classic | Compact | What compact hides for it |
| --- | ---: | ---: | --- |
| New deployment: **New** → **Docker image** | 2 | 2 | Nothing |
| Environment change: Services → service → **Environment** | 3 | 3 | Nothing |
| A deployment's log: … → **Deploys** | 3 | 3 | Nothing |
| The running container's log | 3 | 3 | Nothing. Classic offers **Runtime logs** in the header on any tab; compact shows the log on the **Logs** tab without asking |
| Rollback: … → **Deploys** → a release's rollback control | 3 | 3 | Nothing |
| PostgreSQL backup: Data → Databases → the database → **Backup now** | 3 | 3 | Nothing |
| Restore: Data → Backups → the snapshot's **Restore** | 2 | 2 | Nothing |
| Team access, create the account: System → Users → **New user…** | 2 | 2 | Nothing |
| Team access, give a seat: Organize → Workspaces → **Invite Member** | 2 | 2 | Nothing |

No task in the matrix is longer in compact, and none needs a tab or a card that compact puts away.

The journeys behind the matrix complete in both layouts: first deploy from an image, first source upload with a failed build and its recovery, environment change with rollback, PostgreSQL backup and restore of a protected row, an approval lane, a domain with its Traefik router, and a member who signs in, is seated and deploys.

## What compact hides, measured

Read from a real panel for the operator in the default Simple view.

| | Classic | Compact |
| --- | --- | --- |
| Service tabs up front | 14 | 6: Overview, Deploys, Environment, Domains, Logs, Settings |
| Service tabs under **More** | none | 8: Volumes & Storage, Terminal & Exec, File Browser, Manifest & Traefik, CI, Framework, Architecture, Danger Zone |
| Service settings cards folded under **More settings** while their feature is off | none | 9: target node, build placement, registry push, Swarm orchestrator, container options, canary releases, status badge, restart-loop limit, maintenance mode |
| Sidebar links | 22 in 5 groups | 22 in 5 groups; **Hub** is **New** |
| Tab stops across the service tabs | 14 | 6 |

A deep link to any of the 14 tabs lands on a selected, visible tab in both layouts; in compact **More** opens by itself when one of its tabs is the target. An unknown `?tab=` falls back to Overview. The layout choice survives reloads and direct links in both directions.

## Keyboard, focus and names

- **Keyboard.** Tab reaches the rail's group icons in 4 stops in both layouts (New resource, Deploy, Organize, Data) and the first link of an opened group 5 stops later; every stop is named. Enter opens a group and selects a tab, and selecting a tab leaves the focus on it. From the top of a service page it takes 35 Tab stops to reach the first service tab in classic and 34 in compact; crossing the service tabs then takes 14 and 6. In compact **More** opens from the keyboard and Tab carries on into the tabs it was hiding.
- **Focus in dialogs.** The rollback confirmation, the restore confirmation and **Invite Member** took the focus, kept Tab inside and handed it back. The deploy wizard and the new-database wizard did neither: they were the two dialogs still on a hand-rolled focus effect. They now use the shared hook (see the fixes below).
- **Names.** Four controls on the task pages had no name a screen reader could use: the environment card's add button (an icon), the value field of an existing variable (a placeholder that is empty for a plain variable), the PR-preview switch (its heading sits outside its `<label>`), and the deploy wizard's close button. Compact added none of its own; every page and dialog is clean in both layouts.
- **Turkish.** The compact names are translated and read correctly: `Loglar`, `Alan adları`, `Diğer`, `Diğer ayarlar`, `Yeni`.

## Phone width

At 412 px the tab strip is one row that scrolls sideways.

| | Classic | Compact |
| --- | --- | --- |
| Width of the tab strip | 1677 px | 701 px, plus 983 px for the tabs under **More** |
| A deep link to a tab that sits off-screen | Selected tab stayed outside the strip for 4 of 5 links | Same for the last primary tab and the last tab under **More** |

A group icon opens the drawer, each of the five groups reaches the pages the tasks start from, and the drawer closes behind the navigation. The member signs in, reaches a workspace service through the rail, and is refused an operator page with one sentence. Both are fixed below: the page now brings a deep-linked tab on screen, and an early tap on a group icon is no longer undone.

## The member

The operator creates the account under **Users** and seats it under **Workspaces** with the **member** role. In the member's own session the workspace names them a member and lists their account with that role, the workspace's services are visible, and a deploy from the picker succeeds.

Operator-only routes answer 403 to the member's token. In the page, `/users`, `/volumes` and `/activity` each show one sentence that ends in "operators only." and make no request that can only be refused. The member's sidebar never offers an operator page: Data lists Databases and Backups but not Volumes, and System lists Monitoring, Settings and About.

## Defects found and fixed

Each product fix has a unit test, and a journey that was red on the baseline image is green on the candidate. "Both" means the defect was the same in classic and compact; the journeys found them because they walk the same tasks in both. Four of the unit tests were written before their fix and their failing run is kept (`red-static-cache.log`, `red-workspaces-member.log`, `red-layout-drawer.log`, `red-phone.log`); the others were written after it.

| Finding | Where | Fix |
| --- | --- | --- |
| On the **Logs** tab the header button read **Runtime logs** while the log was already on the page, and changed to **Hide logs** without hiding it | Compact only | The button says what is on the page, and hides and shows the log on that tab (`service/index.tsx`) |
| The deploy and database wizards did not keep Tab inside and dropped the focus when closed; the deploy wizard's close button had no name | Both | Both use the shared `useDialogFocus` hook; the close button is named |
| The shared hook counted a control the browser skips as its last Tab stop: both wizards hide **Back** on the first step, so Tab left the dialog for the page behind it | Both | The hook counts only real Tab stops. This fix and its test came from a session running in the same checkout at the same time; N10's focus journey depends on it and verifies it |
| Four unnamed controls on the task pages | Both | Names added; an existing variable's value is named after its key |
| A member opening **Workspaces** asked for the invitations only an admin can list, and the console showed a 403 | Both | The page asks only when the user can manage invitations |
| Every page load asked the panel again for all 29 hashed files: a service page cost 52 requests, its Settings tab 72 | Both | A file whose name carries the build hash is served `immutable`; the entry page is still asked for every time (`staticFiles.ts`) |
| On a phone, tapping a group icon in the first moments of the page opened the drawer and lost it at once | Both | Only a navigation, or arriving at a phone width, closes the drawer (`Layout.tsx`) |
| On a phone, a deep link left the selected tab outside the strip | Both | The page brings the selected tab on screen once the strip exists |
| The browser harness selected its projects with patterns that Playwright matches against a file's whole path, so a checkout under a directory such as `n10-…` put every file into the desktop projects | Harness | Every pattern is anchored to the file's name (`e2e/playwright.config.ts`) |

## Result on the candidate

The candidate image is `sha256:47e82df0da212893c497a0179bfacade5f106b8e437478b7aa9eabcbbf04cb35`: `841b2b27` plus the N10 changes and the shared-hook fix, and nothing else. Another session was editing the checkout while this ran, so the image was built from a tree that holds only those files.

All five projects ran on a fresh panel each time: setup 1 journey, desktop 15, phone 16, desktop-compact 17, phone-compact 16.

| Run | Harness | Result | Playwright duration |
| --- | --- | --- | --- |
| 1 | before two measurement corrections below | 65 of 65 passed | 15.8 min |
| 2 | final | 65 of 65 passed | 14.9 min |
| 3 | final, started right after run 2 | 65 of 65 passed | 16.7 min |

No test was skipped, failed or retried in any run, and the Release workflow's report check accepts each report. The desktop project takes about 7 minutes and the compact one about 6.7; each phone project takes about half a minute.

The two corrections between runs 1 and 2 are in how the journeys measure, not in what they require. The keyboard walk now starts from the first control of the page, because a page that was moved by a click keeps its place in the Tab order. And the cost of a page load is read from what the browser fetched over the network: Playwright also reports the responses it served from its own cache, so a counter of `response` events did not move when the caching changed.

Measured on the candidate, in both layouts:

- The service page fetched 17 hashed files on a first visit and 0 on a later load in the same browser.
- Every dialog took the focus, kept Tab inside and handed it back.
- No page or dialog on the task paths has a control without a name.
- A deep link brings its tab on screen at phone width, and the drawer stays open when a group icon is tapped right after the page appears.
- A browser that never chose gets compact, a chosen Classic survives a reload, and another browser that never chose gets compact again.

## The default layout

**Compact is now the layout a browser gets until it chooses one.** The comparison above is the evidence: every allowed journey completes in compact at the same number of clicks, nothing the tasks need is put away, the service tabs take 8 Tab stops fewer to cross and the tab strip is less than half as wide on a phone, and the only defect specific to compact is fixed.

- **An explicit choice is kept.** Someone who chose Classic keeps it, exactly as a stored Compact was always kept.
- **The fallback for a new session.** A browser that never chose gets Compact: a first visit, a new browser profile, a private window, or a browser that refuses storage. Where storage is refused a choice lasts for the page only.
- **To hold the default back**, set `DEFAULT_LAYOUT` in `apps/web/src/lib/layout.ts` to `'classic'` and restore the two catalogue lines of the layout choice in `apps/web/src/locales/tr.ts`. Everything else stands: the journeys pin the layout of each project, and the unit suite runs against classic unless a test sets the layout itself.

User feedback was not available for this decision. Everything here is browser evidence.

## Left open

One item that was listed here first is closed. **A `HEAD` request to a client-side route answered 404** while `GET` got the entry page, so a monitor that probes a page with `HEAD` read a panel that was down. `HEAD` now gets the answer of `GET` without the body, the consent page's frame refusal included; API paths and every other method keep their 404. The unit test was written first and failed on the committed code (`red-head-route.log`). The plugin was then built from the commit plus this one change, in a tree without the other sessions' files, and asked over a real socket. Before, `HEAD /services/42` answered 404. After, it answers 200 with the `content-type`, `content-length` and `cache-control` of `GET` and no body (`head-probe-before.log`, `head-probe-after.log`).

- **On a phone, More is not on screen until the strip is scrolled.** It is the last item of a 701 px row in a 330 px strip. Classic's strip is 1677 px wide, so most of its tabs are off-screen the same way and this is not a regression, but the default layout still has one control a person has to swipe to find. A sticky **More**, or an affordance that the strip scrolls, is the next small change.
- **Grouping instance Settings by task.** The Settings page is the same in both layouts: 20 sections in 4 groups. The comparison recorded that count as the starting point for that work.
- **The panel asks for a lot on each view.** Beyond the files of a first visit, a page view makes 13 to 17 shell requests (projects and labels three times each), and a service page 22 to 42, depending on the tab. Walking the nine operator tasks costs 105 to 110 API requests; four deep links into a service with two reloads of the Appearance page cost about 290. The panel admits a signed-in user 1,000 API requests a minute and an address 1,000 other requests a minute; a first draft of the N10 journeys exceeded that on a reloaded panel and received a 429 with the code `internal_error` as the whole document. The journeys now move through the panel's own navigation; the counts remain a fact for the capacity work.
- **A request for a file that does not exist under `assets/` gets the entry page with 200.** The fallback is kept from `/v1`, `/health`, `/hooks` and `/events` only, so `/assets/missing.js` answers 200 with HTML: to `GET` as before, and since the `HEAD` fix to `HEAD` as well. A tab from before an upgrade that asks for a file of the previous build gets a page it cannot use as a script. The same probe found this; it is not changed.
- **README screenshots** are made with the `screens` project and will show compact once regenerated.

## Hosted run

After the commit was pushed, hosted CI passed on `c4a8a0339095dee4e0ef19beff58dbadfb7f9345`: 20,183 tests in the eight workspace packages (14,744 server, 2,883 web, 1,206 CLI, 808 schemas, 397 SDK, 85 db, 53 MCP, 7 plugin-sdk), with server coverage above every floor (93.43 % statements, 88.40 % branches, 91.92 % functions, 96.60 % lines). The [Browser journeys workflow](https://github.com/ninedeploy/ninedeploy/actions/runs/45279201742) then ran all five projects on the published `main-c4a8a033` image and passed **65 of 65**, with the README screenshot test skipped by design. The [CI run](https://github.com/ninedeploy/ninedeploy/actions/runs/45270693627) is the first hosted evidence for every commit after v0.19.0.

The first of those hosted runs, on the commit before, [failed one server test](https://github.com/ninedeploy/ninedeploy/actions/runs/45262642560). It was not N10's: the browser release gate job that N08 had added to `release-publish.yml` set Node up without the repository's runtime check. `c4a8a033` adds it. Ten older jobs in other workflows do the same and are not covered by that test.

## Limits of this evidence

- This is browser evidence from automated journeys, run on a local Docker Desktop panel and then in hosted CI. No person used either layout for this record, and no manual screen-reader session was held. "A control has a name" is decided by a script that follows the order a browser uses: `aria-label`, `aria-labelledby`, a `<label>`, the text, the `title`, and for fields the placeholder.
- The journeys check five deep links per layout on every run. All fourteen were checked once per layout, on the baseline image.
- The hosted runs cover the pushed commits only. The full release gate (`pnpm release:check`) and the release workflow's digest-pinned gate have not been run on a release candidate.

## Evidence

Under `.temp_files/n10-compact-20261123/` (git-ignored):

- `baseline-image.txt`: the baseline image, `841b2b27` built without any N10 change.
- `candidate2-image.txt`, `candidate2-base-head.txt`, `candidate2-source-hashes.txt`: the candidate image and the hash of every file that differs from `841b2b27` in it. The tree it was built from is `.temp_files/n10-candidate-tree/`.
- `iter5-desktop-classic.json`, `iter5-desktop-compact-n10.json`, `iter5-desktop-compact-core.json`, `iter6-phone-baseline.json`: the measurements on the baseline image, including the red journeys.
- `run5-candidate2-a.json`, `run6-candidate2-b.json`, `run7-candidate2-c.json`: the three runs of all five projects on the candidate. `run6-harness-hashes.txt` and `run5-smoke-copy.diff` record the journeys as run and the three lines that differ in the tree's copy of the smoke script (it launches the installed Playwright directly).
- `red-static-cache.log`, `red-workspaces-member.log`, `red-layout-drawer.log`, `red-phone.log`, and `green-*.log`: unit tests before and after the fixes. `web-full-flip.log` is the first complete web suite with the new default, in which two tests that encoded the old default failed and were corrected; `web-full-final.log` is the clean run of all 245 files. `server-focused.log` holds the server suites that read the changed files.
- `explore-*.mjs`: the probes behind the phone, fold, focus, member and cache facts.
- `red-head-route.log`, `green-head-route.log`: the `HEAD` unit test before and after its fix. `head-typecheck-server.log` and `head-focused-server.log` are the server typecheck and five server suites (1,180 tests) in the isolated tree. `head-probe.mjs`, `head-probe-before.log` and `head-probe-after.log` are the real-socket probe. `ci-test-totals.mjs` and `ci-preflight-overlap.mjs` read the hosted test count from the job log.
