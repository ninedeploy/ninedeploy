import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Smart HTTP fixture: the real git http-backend serves only the owned repository. */
export function gitHttpServerCode(root = '/repo', port = 8080) {
  function main(root, port) {
    const { createServer } = require('node:http'), { spawn } = require('node:child_process'), fs = require('node:fs');
    fs.mkdirSync(root, { recursive: true }); const active = new Set(); let requests = 0;
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      if (url.pathname === '/health') { res.end(JSON.stringify({ active: active.size, requests })); return; }
      if (!['GET', 'POST'].includes(req.method) || !['/repo.git/info/refs', '/repo.git/git-upload-pack'].includes(url.pathname)) {
        res.statusCode = 404; res.end(); return;
      }
      requests++;
      const child = spawn('git', ['-c', 'safe.directory=*', 'http-backend'], { windowsHide: true,
        env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, REMOTE_ADDR: '127.0.0.1',
          CONTENT_TYPE: req.headers['content-type'] || '', CONTENT_LENGTH: req.headers['content-length'] || '',
          HTTP_GIT_PROTOCOL: req.headers['git-protocol'] || '' }, stdio: ['pipe', 'pipe', 'ignore'] });
      active.add(child); let headers = Buffer.alloc(0), started = false;
      const failed = () => { if (!res.headersSent) res.statusCode = 502; res.end(); child.kill(); };
      const timer = setTimeout(failed, 30_000);
      child.on('error', failed); child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        if (started) { res.write(chunk); return; }
        headers = Buffer.concat([headers, chunk]);
        const boundary = headers.indexOf('\r\n\r\n');
        if (boundary < 0) { if (headers.length > 16384) failed(); return; }
        let status = 200; const values = {};
        for (const line of headers.subarray(0, boundary).toString().split('\r\n')) {
          const colon = line.indexOf(':'); if (colon < 1) continue;
          const key = line.slice(0, colon), value = line.slice(colon + 1).trim();
          if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]); else values[key] = value;
        }
        res.writeHead(status, values); started = true; res.write(headers.subarray(boundary + 4)); headers = Buffer.alloc(0);
      });
      child.stdout.on('end', () => { if (!started && !res.headersSent) res.statusCode = 502; res.end(); });
      child.on('close', () => { clearTimeout(timer); active.delete(child); });
      req.on('aborted', () => child.kill()); res.on('close', () => { if (!res.writableEnded) child.kill(); });
      req.pipe(child.stdin);
    });
    server.requestTimeout = 35_000; server.headersTimeout = 10_000;
    server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ port: server.address().port })));
  }
  return `(${main.toString()})(${JSON.stringify(root)},${JSON.stringify(port)})`;
}

export function createSwarmGitRepository(root) {
  const work = join(root, 'work'), bare = join(root, 'repo.git'); mkdirSync(work, { recursive: true });
  const git = (args, cwd = work) => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Owned runtime fixture', '-c', 'user.email=proof@example.test', ...args],
      { cwd, windowsHide: true, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const health = "const q=require('node:http').get('http://127.0.0.1:8080/ready',r=>{r.resume();process.exit(r.statusCode===200?0:1)});q.on('error',()=>process.exit(1));q.setTimeout(1500,()=>process.exit(1))";
  const write = label => {
    writeFileSync(join(work, 'Dockerfile'), `FROM node:26-slim\nWORKDIR /app\nCOPY app.cjs /app/app.cjs\nHEALTHCHECK --interval=2s --timeout=3s --retries=3 --start-period=120s CMD ${JSON.stringify(['node', '-e', health])}\nEXPOSE 8080\nCMD ["node","/app/app.cjs"]\n`);
    writeFileSync(join(work, 'app.cjs'), `const fs=require('node:fs');require('node:http').createServer((q,r)=>{const ready=process.env.NEEDS_READINESS!=='1'||fs.existsSync('/tmp/nd-ready');r.statusCode=ready?200:503;r.end(ready?${JSON.stringify(label)}:'booting')}).listen(8080,'0.0.0.0');\n`);
  };
  git(['init', '-b', 'main']); write('baked-one'); git(['add', 'Dockerfile', 'app.cjs']); git(['commit', '-m', 'First owned artifact']);
  const first = git(['rev-parse', 'HEAD']); git(['clone', '--bare', '--no-hardlinks', work, bare]);
  return { bare, first, advance() {
    write('baked-two'); git(['add', 'Dockerfile', 'app.cjs']); git(['commit', '-m', 'Second owned artifact']);
    const second = git(['rev-parse', 'HEAD']); git(['--git-dir', bare, 'fetch', work, 'main:main']); return second;
  } };
}
