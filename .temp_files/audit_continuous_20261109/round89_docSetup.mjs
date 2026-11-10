import fs from 'node:fs';const p='docs/MACOS_DEVELOPMENT.md';let s=fs.readFileSync(p,'utf8').replaceAll('\r\n','\n');const anchor='## Open the same source revision\n';if(!s.includes(anchor))throw Error('Mac guide anchor missing');const section=`## Native server regressions on hosted macOS

The [manual server audit workflow](../.github/workflows/macos-server-audit.yml)
checks backend filesystem, SQLite, scheduler, image and LFS regressions on a
native macOS runner. It installs the root frozen lockfile, builds the server and
its workspace dependencies, and runs 24 focused test files plus four controlled
Docker CLI integration files. Docker CLI is installed without starting a daemon;
all native CLI cases use private configs and loopback fixtures.

Use **Actions → macOS server audit → Run workflow** on main, or an authenticated
GitHub CLI:

\`\`\`sh
gh workflow run macos-server-audit.yml --repo ninedeploy/ninedeploy --ref main
gh run list --repo ninedeploy/ninedeploy --workflow macos-server-audit.yml --limit 3
\`\`\`

Download the run's audit artifact for exact source SHA, OS/architecture, tool
versions and logs. The runner uses .node-version, the root pinned pnpm and
GOMAXPROCS=4. No GUI, deployment, real registry or Docker daemon is started.
This focused lane is separate from full release/coverage acceptance and normal
Keychain/desktop checks. It does not resolve the round73 Windows worker fault.

Native server run status: not dispatched at this preparation checkpoint.

`;
s=s.replace(anchor,section+anchor);fs.writeFileSync(p,s);
