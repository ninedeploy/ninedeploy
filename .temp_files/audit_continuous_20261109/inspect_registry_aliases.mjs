import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = mkdtempSync(path.join(tmpdir(), 'nd-registry-alias-'));
try {
  for (const server of ['registry.example.test', '', 'docker.io', 'index.docker.io', 'registry-1.docker.io']) {
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ auths: { 'https://index.docker.io/v1/': { auth: Buffer.from('fixture:dummy').toString('base64') } }, credsStore: '', credHelpers: {} }));
    const output = execFileSync('docker', ['--config', root, 'logout', ...(server ? [server] : [])], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    const after = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'));
    console.log(JSON.stringify({ server: server || '(default)', canonicalEntryRemains: Boolean(after.auths?.['https://index.docker.io/v1/']), message: output.trim() }));
  }
} finally { rmSync(root, { recursive: true, force: true }); }
