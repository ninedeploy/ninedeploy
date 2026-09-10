#!/usr/bin/env bash
# One-shot: commit everything, tag v0.7.8, push.
# Run: bash ship-v078.sh
set -e
cd "$(dirname "$0")"

# Remove the helpers first so `git add -A` never picks them up.
rm -f ship-v078.sh ship-v077.sh

git add -A
git commit -m "chore(release): v0.7.8 — hardened-host build fix (buildx/PM2), manifest wiring, installer preflight

Brings the full 0.7.8 content to main: image auto-update watch, manifest
previews/notifications/volume.backups wiring, the buildx+PM2 read-only
/root fixes with an installer deploy preflight, targeted clone-failure
hints, and the coverage/e2e test hardening (journal ordering, SDK
coverage, imageWatch dead-URL and environments UNIQUE-race fixes)."
git tag v0.7.8
git push origin main
git push origin v0.7.8
echo ""
echo "Done. Watch: https://github.com/ninedeploy/ninedeploy/actions"
