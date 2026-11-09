import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
const h = vi.hoisted(() => ({ createFailure: false, writeFailure: 'none' as 'none'|'before'|'partial', removeFailure: false,
  created: new Set<string>(), writeError: new Error('synthetic write failure'), removeCalls: 0 }));
vi.mock('node:fs', async orig => {
  const fs = await orig<typeof import('node:fs')>();
  return { ...fs,
    mkdtempSync: (...args: Parameters<typeof fs.mkdtempSync>) => {
      if(h.createFailure) throw new Error('synthetic create failure');
      const dir = fs.mkdtempSync(...args); h.created.add(resolve(String(dir))); return dir;
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if(h.writeFailure==='before') throw h.writeError;
      if(h.writeFailure==='partial') { fs.writeFileSync(args[0],'partial fixture',args[2]); throw h.writeError; }
      return fs.writeFileSync(...args);
    },
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      const target=resolve(String(args[0]));const root=resolve(tmpdir());
      if(!isAbsolute(target)||!target.startsWith(root+sep)||!h.created.has(target)||!basename(target).startsWith('nd-audit-secret-')) throw new Error('Unexpected cleanup target');
      h.removeCalls++;if(h.removeFailure)throw new Error('synthetic removal failure');return fs.rmSync(...args);
    },
  };
});
const { writeSecretFile } = await import('../../apps/server/src/lib/secretFile.js');
const fs = await import('node:fs');
beforeEach(()=>{h.createFailure=false;h.writeFailure='none';h.removeFailure=false;h.removeCalls=0;expect(h.created.size).toBe(0);});
afterEach(()=>{
  h.createFailure=false;h.writeFailure='none';h.removeFailure=false;
  for(const dir of h.created){fs.rmSync(dir,{recursive:true,force:true});expect(existsSync(dir)).toBe(false);}h.created.clear();
});
const create=()=>writeSecretFile('nd-audit-secret','fixture.env','SYNTHETIC_FIXTURE=one\n');
it('writes exact bytes to its own absolute temp path and cleans them',()=>{
  const file=create();expect(isAbsolute(file.path)).toBe(true);expect(h.created.has(resolve(dirname(file.path)))).toBe(true);
  expect(readFileSync(file.path,'utf8')).toBe('SYNTHETIC_FIXTURE=one\n');file.cleanup();expect(existsSync(dirname(file.path))).toBe(false);
});
it('different instances with the same prefix/name retain independent files',()=>{
  const a=create();const b=create();expect(dirname(a.path)).not.toBe(dirname(b.path));a.cleanup();expect(readFileSync(b.path,'utf8')).toBe('SYNTHETIC_FIXTURE=one\n');b.cleanup();
});
it('cleanup is idempotent after an actual successful removal',()=>{
  const file=create();file.cleanup();expect(()=>file.cleanup()).not.toThrow();expect(existsSync(file.path)).toBe(false);
});
it('failed exclusive directory creation owns nothing to clean',()=>{
  h.createFailure=true;expect(create).toThrow('synthetic create failure');expect(h.created.size).toBe(0);expect(h.removeCalls).toBe(0);
});
for(const failure of ['before','partial'] as const)it(`${failure} write failure preserves the original error and removes its directory`,()=>{
  h.writeFailure=failure;let caught:unknown;try{create();}catch(err){caught=err;}expect(caught).toBe(h.writeError);
  expect(h.created.size).toBe(1);for(const dir of h.created)expect(existsSync(dir)).toBe(false);
});
it('actual removal failure is best-effort, not an exception reaching consumers',()=>{
  const file=create();h.removeFailure=true;expect(()=>file.cleanup()).not.toThrow();expect(existsSync(file.path)).toBe(true);
  h.removeFailure=false;file.cleanup();expect(existsSync(file.path)).toBe(false);
});
it('secondary cleanup failure preserves a partial-write error and is recoverable by fixture cleanup',()=>{
  h.writeFailure='partial';h.removeFailure=true;let caught:unknown;try{create();}catch(err){caught=err;}expect(caught).toBe(h.writeError);
  expect(h.created.size).toBe(1);for(const dir of h.created)expect(existsSync(dir)).toBe(true);
});
