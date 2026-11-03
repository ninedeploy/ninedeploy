import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPersistentPortHostAuthority } from '../../apps/server/src/lib/persistentPortHostAuthority.ts';

const [mode, directory, control] = process.argv.slice(2);
if (!directory?.startsWith('/proof/locks/')) throw new Error('Not an owned lock fixture directory');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const event = value => appendFileSync(join(directory, 'events.log'), value + '\n');
if (mode === 'mutator') {
  event('mutator-enter'); writeFileSync(join(directory, 'mutator-ready'), 'ready');
  const deadline = Date.now() + 20000;
  while (!existsSync(join(directory, 'release')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!existsSync(join(directory, 'release'))) throw new Error('Mutator release deadline');
  event('mutator-finish');
} else if (mode === 'parent') {
  await withPersistentPortHostAuthority(directory, async context => {
    writeFileSync(join(directory, 'parent.pid'), String(process.pid));
    const args = [fileURLToPath(import.meta.url), 'mutator', directory];
    if (control === 'unfenced') {
      // Negative control: a child without descriptor 3 cannot retain authority
      // after its parent is killed. The competing worker must enter early.
      spawnSync(process.execPath, args, { stdio: 'ignore', timeout: 25000 });
    } else context.run(process.execPath, args, { timeoutMs: 25000 });
  });
} else if (mode === 'competitor') {
  writeFileSync(join(directory, 'competitor-attempt'), 'attempt');
  await withPersistentPortHostAuthority(directory, async () => {
    event('competitor-enter'); writeFileSync(join(directory, 'competitor-entered'), 'entered');
  }, 10);
} else if (mode === 'guards') {
  await assert.rejects(() => withPersistentPortHostAuthority('relative', async () => {}), /Invalid/);
  const writable = join(directory, 'writable'); mkdirSync(writable, { mode: 0o700 }); chmodSync(writable, 0o777);
  await assert.rejects(() => withPersistentPortHostAuthority(writable, async () => {}), /not private/);
  assert.equal(existsSync(join(writable, 'authority.lock')), false);
  let escaped;
  await withPersistentPortHostAuthority(directory, async context => {
    escaped = context;
    assert.throws(() => context.run(process.execPath, [], { timeoutMs: 0 }), /deadline/);
  });
  assert.throws(() => escaped.run(process.execPath, ['-e', 'process.exit(1)']), /has ended/);
  writeFileSync(join(directory, 'guards.json'), JSON.stringify({ privateDirectory: true, relativePathRefused: true, deadlineEnforced: true, escapedContextRefused: true }));
} else throw new Error('Unknown lock fixture mode');
