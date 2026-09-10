#!/usr/bin/env bash
# One-shot: commit the r086 coverage fixes, move the v0.7.7 tag, push.
# Run: bash ship-v077.sh
set -e
cd "$(dirname "$0")"

# Remove self first so `git add -A` never picks the helper up.
rm -f "$0"

git add -A
git commit -m "fix(ci): clear coverage thresholds + two latent bugs the push surfaced (r086)"
git tag -f v0.7.7
git push origin main
git push origin v0.7.7 --force
echo ""
echo "Done. Watch the Release workflow: https://github.com/ninedeploy/ninedeploy/actions"
