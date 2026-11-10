import fs from 'node:fs';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';const dir='.temp_files/audit_continuous_20261109/';assert(fs.existsSync(dir+'round99_server_result.json'),'Full run remains active');assert(fs.readFileSync(dir+'F1102_tenancy_before.log','utf8').includes('PROBLEM CONFIRMED'),'Run unchanged selected before-proof first');const result=JSON.parse(fs.readFileSync(dir+'round99_server_result.json','utf8')),file='apps/server/test/tenancyIsolation.test.ts',raw=fs.readFileSync(file,'utf8'),source=raw.replaceAll('\r\n','\n');const expected=execFileSync('git',['rev-parse',result.sourceSha+':'+file],{encoding:'utf8'}).trim(),actual=execFileSync('git',['hash-object','--stdin'],{input:source,encoding:'utf8'}).trim();assert.equal(actual,expected,'Test source changed since full-suite snapshot; inspect and re-prove');const old=`    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === 'docker-content-digest' ? 'sha256:new' : null) },
    }));`;assert(source.includes(old),'Fixture anchor changed');const next=`    const manifestConfig = JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } });
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: \`sha256:\${createHash('sha256').update(manifestConfig).digest('hex')}\`, size: Buffer.byteLength(manifestConfig) },
      layers: [],
    });
    const digest = \`sha256:\${createHash('sha256').update(manifest).digest('hex')}\`;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(manifest, {
      status: 200,
      headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json', 'docker-content-digest': digest },
    }));`;let patched=source.replace(old,next);assert(patched.includes("import { createHmac } from 'node:crypto';"),'Import anchor changed');patched=patched.replace("import { createHmac } from 'node:crypto';","import { createHash, createHmac } from 'node:crypto';");assert.equal(fs.readFileSync(file,'utf8'),raw,'Concurrent source drift');fs.writeFileSync(file,patched);console.log('Updated only the stale LAN registry HTTP fixture; production verification remains unchanged');
