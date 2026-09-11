# Ship v0.8.0: commit everything, tag, push.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File .\ship-v080.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Remove-Item .\ship-v080.ps1 -ErrorAction SilentlyContinue

git add -A
git commit -m "chore(release): v0.8.0 — Bitbucket end-to-end, quote-aware hooks, agent op timeouts, DB restore fixes"
git tag v0.8.0
git push origin main
git push origin v0.8.0
Write-Host ""
Write-Host "Done. Watch: https://github.com/ninedeploy/ninedeploy/actions"
