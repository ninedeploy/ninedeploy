import { readFileSync, writeFileSync } from 'node:fs';
const f = 'D:/Codebox/PROJECTS/NineDeploy/apps/server/test/builders/docker.test.ts';
let s = readFileSync(f, 'utf8');
const broken = "healthPath: '/health' } })\r\n\r\n  it('leaves imageDigest";
const fixed = "healthPath: '/health' } });\r\n\r\n    const runtime = await dockerBuilder.buildAndRun(ctx as never);\r\n\r\n    expect(runtime.imageDigest).toBeUndefined();\r\n  });\r\n\r\n  it('leaves imageDigest";
const idx = s.indexOf(broken);
console.log('idx:', idx);
if (idx < 0) { console.error('NOT FOUND'); process.exit(1); }
s = s.replace(broken, fixed);
writeFileSync(f, s);
console.log('OK');
