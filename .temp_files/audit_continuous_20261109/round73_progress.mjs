import { readFileSync } from 'node:fs';
const suffix = process.argv.includes('--retry') ? 'retry' : 'full';
const source = readFileSync(`.temp_files/audit_continuous_20261109/round73_server_${suffix}.log`, 'utf8');
const reached = new Set([...source.matchAll(/^\s*[✓×]\s+(test\/.*?\.test\.ts)\s*>/gm)].map(match => match[1]));
console.log(new Date().toISOString(), { reachedFiles: reached.size, passedLines: (source.match(/^\s*✓ /gm) || []).length, failedLines: (source.match(/^\s*× /gm) || []).length });
console.log(source.split('\n').slice(-5).join('\n'));
