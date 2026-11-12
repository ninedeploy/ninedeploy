# Contributing to NineDeploy

Thanks for helping. Bug reports, fixes, docs, translations and templates are all welcome.

## Before you start

- For a bug, open an issue with the **Bug report** form first, unless the fix is obvious and small.
- For a feature, open a **Feature request** issue, or comment on an item in the [roadmap](docs/plans/COMPETITIVE_ROADMAP_2026-11.md). That way you know it fits before you write it.
- For a security problem, **do not open an issue**. Follow [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 22.23.4+, 24.22.1+ or 26.12.1+, pnpm 11 and Docker.

```bash
pnpm install
pnpm build          # the server and web depend on the built workspace packages
pnpm dev            # the API server
pnpm dev:web        # the web panel, in a second terminal
```

The panel drives the Docker daemon it can reach. On a machine that runs other projects' containers, use a separate daemon (for example Docker-in-Docker) for anything that deploys.

For a native Mac setup, the separate desktop lockfile and Keychain/DMG acceptance, follow [Developing on macOS](docs/MACOS_DEVELOPMENT.md).

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- Biome formats and lints. Vitest runs the tests. Turborepo caches both.
- Run one test file with `pnpm exec vitest run test/<file>.test.ts` inside `apps/server` or `apps/web`.
- Some guard tests only fail in a full `apps/server` run, so run it before a pull request that adds a route, an environment variable or a module. These guards cover:
  - every mutating route reaching `audit()`;
  - every route in the authorization matrix and the OpenAPI surface;
  - every environment variable in `.env.example`;
  - no import cycles;
  - every per-entity settings key declared in `lib/ownedSettings.ts`, with its stored shape in `lib/ownedSettingSchemas.ts` (read JSON rows through `readOwnedSettingJson`).

## The rules every change follows

Installed panels update themselves, so every release reaches every operator. A change must let a running server upgrade in place without breaking.

- **Migrations are additive.** Add tables, nullable columns or columns with defaults. Never drop or rename a column in the same release that stops using it. Migrations are hand-written in `packages/db/src/migrations`, and `test/schema-drift.test.ts` must stay green.
- **New behaviour is opt-in,** or keeps the old default.
- **Wire what you write.** A module is not done until something mounts it and a test asserts that mount: a registered route, a scheduled job, a rendered card. Unit tests alone have missed this before.
- **Commands run as argument lists.** Never build a shell string from user input.
- **Secrets** are encrypted at rest, write-only in the API, and never logged.
- **Keep `CHANGELOG.md` honest.** Add a line under `[Unreleased]` saying what changes for the operator. Say what does not work yet as plainly as what does. CI, test and tooling changes go under `### Internal` at the end of the section.

## Translations

The web panel ships in English and Turkish. The English text in the source is the message key; Turkish entries live in `apps/web/src/locales/tr.ts`. See [docs/TRANSLATIONS.md](docs/TRANSLATIONS.md) for how to add a string or a language.

## Templates

One-click templates are reviewed for pinned images and closed-by-default exposure, and each one is smoke-deployed before it is listed. See [docs/TEMPLATE_MIRRORS.md](docs/TEMPLATE_MIRRORS.md).

## Releases and the stable channel

Maintainers tag releases. Each release's `CHANGELOG.md` section opens with a block for the people who run NineDeploy: **Highlights**, one to three bullets a user notices, and an **Action needed:** line (`No.`, optionally with a short note, or `Yes: <what to do>`). The GitHub release notes lead with that block (`scripts/release-notes.mjs`), and `pnpm release:tag` refuses a version whose section lacks it. A stable marker (below) written in the section is carried into the release notes.

Every release is offered at once to panels on the default channel. Panels on the **stable** channel get only the release that the `stable` tag points at. Once a day, `.github/workflows/stable-channel.yml` moves that tag to the newest release that has been out for 7 days. Two markers in a GitHub release's notes change that:

- `<!-- stable: hold -->` keeps a release off stable, for example while a regression is investigated.
- `<!-- stable: security -->` promotes it at the next run without waiting.

The tag never moves backwards. To promote a tag by hand, run the workflow with its `tag` input. Use `dry_run` to see what it would do.

## Pull requests

- Keep one change per pull request, and describe what an operator will notice.
- Include the test that fails without your change.
- By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
