# Security policy

NineDeploy runs with access to the Docker socket and holds your deploy credentials, so we treat security reports as the highest priority.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**.

Please include:
- the affected version (the panel's About page or `GET /v1/about`) and install mode (bare metal or Docker);
- what an attacker needs: an account and its role, network access to the panel, or nothing;
- steps to reproduce, or a proof of concept;
- the impact you observed.

We will confirm we received it, keep you informed while we work on a fix, and credit you in the advisory unless you prefer not to be named. Please give us a reasonable time to release a fix before you disclose it.

## Supported versions

Fixes ship in a new patch release on the current minor line (0.18.x today). Panels pick up a release through the built-in updater. Older lines do not receive fixes, so upgrade to get them.

## Verifying what you run

Every release is signed through Sigstore and carries build provenance. See [Verifying a release](README.md#verifying-a-release) to check an image, an installer or the source archive before you trust it.

## Hardening already in place

The architecture guide describes the design:
- a setup token on first boot;
- argument-list command execution, never shell strings;
- encrypted secrets and backups;
- per-node agent keys;
- an audit log of every change.

See [ARCHITECTURE.md](ARCHITECTURE.md). Earlier audit reports are kept in [docs/](docs/).
