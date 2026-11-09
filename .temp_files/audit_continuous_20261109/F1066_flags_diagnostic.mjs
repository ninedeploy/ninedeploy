import {mkdtempSync,openSync,writeFileSync,fstatSync,appendFileSync,ftruncateSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os'; import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'nd-log-flags-diagnostic-'));
for(const mode of ['a','a+','r+']) { const file=join(dir,mode.replace('+','plus')+'.log'); writeFileSync(file,'prefix'); const fd=openSync(file,mode); try { appendFileSync(fd,'suffix'); console.log(mode,'before',fstatSync(fd).size); try {ftruncateSync(fd,6);console.log(mode,'truncate passed',fstatSync(fd).size);} catch(e) {console.log(mode,'truncate error',e.code);} } finally {closeSync(fd);} }
