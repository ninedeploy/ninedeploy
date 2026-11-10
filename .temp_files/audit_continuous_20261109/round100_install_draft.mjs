import fs from 'node:fs';import assert from 'node:assert/strict';
const dir='.temp_files/audit_continuous_20261109/';
assert(fs.existsSync(dir+'round99_server_result.json'),'Full Windows unit run has not completed; do not change tracked files');
const result=JSON.parse(fs.readFileSync(dir+'round99_server_result.json','utf8'));
assert(result.completedAt&&result.unchangedHead&&result.cleanEnd,'Full-run source identity must be reviewed before installation');
const target='.github/workflows/macos-server-full-unit-audit.yml',docfile='docs/MACOS_DEVELOPMENT.md',raw=fs.readFileSync(docfile,'utf8'),doc=raw.replaceAll('\r\n','\n'),anchor='## Open the same source revision',note=fs.readFileSync(dir+'round100_macos_full_note_draft.md','utf8').replaceAll('\r\n','\n').trim()+'\n\n';
assert(!fs.existsSync(target),'Workflow already exists; inspect rather than overwrite');assert(!doc.includes('## Full backend unit verification on native macOS'),'Note already exists');assert.equal(doc.split(anchor).length,2,'Documentation anchor changed');
const draft=fs.readFileSync(dir+'round100_macos_server_full_draft.yml','utf8');assert(draft.includes('name: macOS server full unit audit'));assert.equal(fs.readFileSync(docfile,'utf8'),raw,'Documentation changed concurrently');
fs.copyFileSync(dir+'round100_macos_server_full_draft.yml',target,fs.constants.COPYFILE_EXCL);fs.writeFileSync(docfile,doc.replace(anchor,note+anchor));console.log('Installed authorized manual full Mac workflow and handoff note; hosted execution still pending');
