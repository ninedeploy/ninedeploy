import { readFileSync } from 'node:fs';
const f = 'D:/Codebox/PROJECTS/NineDeploy/apps/server/test/builders/docker.test.ts';
const s = readFileSync(f, 'utf8');
const idx = s.indexOf('mockRejectedValue');
if (idx < 0) { console.error('not found'); process.exit(1); }
console.log('idx:', idx);
console.log(JSON.stringify(s.slice(idx, idx + 100)));
