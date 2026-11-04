import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
const [directory, mode] = process.argv.slice(2);
if (!resolve(directory ?? '').startsWith('/tmp/nd-port-journal-')) throw new Error('Not an owned journal fixture directory');
const input = JSON.parse(fs.readFileSync(join(directory, 'input.json'), 'utf8'));
const events = [];
const originalFsync = fs.fsyncSync, originalRename = fs.renameSync;
let fileSynced = false;
fs.fsyncSync = fd => {
  const file = fs.fstatSync(fd).isFile();
  events.push(file ? 'file-sync' : 'directory-sync');
  originalFsync(fd);
  if (file) fileSynced = true;
  if (file && mode === 'kill-before-rename') process.kill(process.pid, 'SIGKILL');
  if (!file && mode === 'lost-durable-ack') throw new Error('injected lost durable acknowledgement');
};
fs.renameSync = (from, to) => {
  if (!fileSynced) throw new Error('Rename occurred before file sync');
  events.push('rename'); originalRename(from, to);
  if (mode === 'kill-after-rename') process.kill(process.pid, 'SIGKILL');
};
syncBuiltinESMExports();
const { withPersistentPortJournalStore } = await import('../../apps/server/src/lib/persistentPortJournalStore.ts');
let error;
await withPersistentPortJournalStore(directory, input.spec, async store => {
  try {
    if (mode === 'probe-read') store.read();
    else store.save(input.journal);
  } catch (failure) { error = String(failure); }
});
fs.writeFileSync(join(directory, 'events.json'), JSON.stringify({ events, error }));
if (mode === 'probe-read') {
  if (!error?.includes('Unsafe persistent port journal file')) throw new Error('Special file was not refused');
} else if (mode === 'lost-durable-ack') {
  if (!error?.includes('injected lost durable acknowledgement')) throw new Error('Fault did not reach the durable boundary');
} else if (error) throw new Error(error);
