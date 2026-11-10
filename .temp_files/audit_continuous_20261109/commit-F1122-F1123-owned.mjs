import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { stageUnreleasedEntry } from './stage-unreleased-entry.mjs';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const dir = '.temp_files/audit_continuous_20261109/';
const baseline = git('rev-parse', 'HEAD');
const source = ['apps/server/src/engine/logDrainTargets.ts', 'apps/server/test/engine/elasticsearchAcknowledgement.test.ts'];
const evidence = [dir+'commit-F1122-F1123-owned.mjs', '.temp_files/ledger_elasticAck105_20261110.md', ...readdirSync(dir).filter(n => /^(F(?:1122|1123).*\.(log|ts|mjs|json|sh)|round102_.*\.(txt|log|ts|mjs|json|sh)|(?:prove|verify)_F(?:1122|1123)_.*\.(ts|mjs)|inspect_round102_.*\.mjs)$/.test(n)).map(n => dir+n)];
const allowed = new Set([...source, ...evidence, 'CHANGELOG.md']);
for (const p of evidence) writeFileSync(p, readFileSync(p, 'utf8').split(/\r?\n/).map(l => l.trimEnd()).join('\n').trimEnd()+'\n');
const expected = Object.fromEntries([...source, ...evidence].map(p => [p, execFileSync('git', ['hash-object', '--stdin'], { input: readFileSync(p,'utf8').replace(/\r\n/g,'\n'), encoding:'utf8' }).trim()]));
git('add','-f','--',...evidence); git('add','--',...source);
const entries = [
 '- Elasticsearch drains retain queued logs when a bulk acknowledgement is unreadable or malformed instead of recording delivery success (F1122).',
 '- Elasticsearch drains recognize filtered per-item bulk errors even when the top-level error flag is omitted (F1123).',
];
stageUnreleasedEntry(entries[0]);
let stagedChangelog=execFileSync('git',['show',':CHANGELOG.md'],{encoding:'utf8'});
if(stagedChangelog.includes('(F1123)'))throw new Error('Finding1123 already exists; inspect HEAD');
if(!stagedChangelog.includes(entries[0]))throw new Error('First owned note missing');
stagedChangelog=stagedChangelog.replace(entries[0],entries.join('\n'));
const stagedHash=execFileSync('git',['hash-object','-w','--stdin'],{input:stagedChangelog,encoding:'utf8'}).trim();git('update-index','--cacheinfo','100644',stagedHash,'CHANGELOG.md');expected['CHANGELOG.md']=stagedHash;
// Mirror only owned notes into the working file; the staged blob still comes from HEAD.
const stagedDoc=execFileSync('git',['show',':CHANGELOG.md'],{encoding:'utf8'});
const localDoc=readFileSync('CHANGELOG.md','utf8').replace(/\r\n/g,'\n');
const ownIds=new Set([1122,1123]);
const notes=stagedDoc.split('\n').filter(line=>ownIds.has(Number(/\(F(\d+)\)\.$/.exec(line)?.[1])));
if(notes.length!==ownIds.size)throw new Error('Missing owned notes for working-file reconciliation');
let local=localDoc.split('\n').filter(line=>!ownIds.has(Number(/\(F(\d+)\)\.$/.exec(line)?.[1]))).join('\n');
const header='## [Unreleased]\n', begin=local.indexOf(header)+header.length, next=local.indexOf('\n## [',begin), end=next<0?local.length:next;
let body=local.slice(begin,end);const anchor='### Fixed\n\n';if(!body.includes(anchor))throw new Error('Working Unreleased Fixed missing');
body=body.replace(anchor,anchor+notes.join('\n')+'\n');local=local.slice(0,begin)+body+local.slice(end);
if(readFileSync('CHANGELOG.md','utf8').replace(/\r\n/g,'\n')!==localDoc)throw new Error('Working changelog changed during reconciliation');
if(local!==localDoc)writeFileSync('CHANGELOG.md',local);
git('diff','--cached','--check');
execFileSync('node',['.temp_files/audit_seven_20261109/staged-check-fast.mjs'],{stdio:'inherit'});
const staged=git('diff','--cached','--name-only').split('\n').filter(Boolean);
if(staged.some(p=>!allowed.has(p))) throw new Error('Unrelated staged path');
for(const p of source) if(!staged.includes(p)) throw new Error('Missing source '+p);
console.log('Verified owned staged paths:',staged.length);
if(process.argv.includes('--prepare')) process.exit(0);
if(git('rev-parse','HEAD')!==baseline) throw new Error('HEAD advanced during staging');
console.log(git('commit','-m','fix: retain log batches after invalid Elasticsearch acknowledgements'));
for(const [p,h] of Object.entries(expected)) if(git('rev-parse','HEAD:'+p)!==h) throw new Error('Committed blob mismatch '+p);
console.log('All selected HEAD blobs verified:',git('rev-parse','HEAD'));
if(!process.argv.includes('--commit-only')){
console.log(git('push','origin','main'));
console.log('Remote main:',git('ls-remote','origin','refs/heads/main'));
}
