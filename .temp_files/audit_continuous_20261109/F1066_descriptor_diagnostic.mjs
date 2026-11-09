import {mkdtempSync,openSync,fstatSync,appendFileSync,ftruncateSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os'; import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'nd-log-truncate-diagnostic-')); const fd=openSync(join(dir,'test.log'),'a');
try { appendFileSync(fd,'fixture'); console.log('before',fstatSync(fd).size); ftruncateSync(fd,0); console.log('after',fstatSync(fd).size); } finally { closeSync(fd); }
