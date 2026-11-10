import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(()=>({short:false}));
vi.mock('node:fs',async original=>{const actual=await original<typeof import('node:fs')>();return {...actual,writeSync:((...args:Parameters<typeof actual.writeSync>)=>{if(!state.short)return actual.writeSync(...args);const [fd,data,offset,length,position]=args as unknown as [number,string|Buffer,number,number,number];return typeof data==='string'?actual.writeSync(fd,data.slice(0,3)):actual.writeSync(fd,data,offset,Math.min(length,3),position);}) as typeof actual.writeSync};});
const {acquireCrossProcessLock}=await import('../../apps/server/src/lib/crossProcessLock.js');
const roots:string[]=[];
function file(){const root=path.resolve(mkdtempSync(path.join(tmpdir(),'nd-lock-identity-audit-')));roots.push(root);return path.join(root,'operation.lock');}
afterEach(()=>{state.short=false;for(const root of roots.splice(0)){if(!root.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(root).startsWith('nd-lock-identity-audit-'))throw new Error('Unowned cleanup');rmSync(root,{recursive:true,force:true});}});
it('control: full native token write is removed by its own release',async()=>{const target=file(),holder=await acquireCrossProcessLock(target);expect(readFileSync(target,'utf8')).toMatch(/^\d+ \d+ [a-f0-9-]+\n$/);holder.release();expect(existsSync(target)).toBe(false);});
it('short native token writes still permit owned release',async()=>{const target=file();state.short=true;const holder=await acquireCrossProcessLock(target);const token=readFileSync(target,'utf8');holder.release();const actual=existsSync(target);console.log('EXPECTED: owned lock removed ACTUAL:',actual?'orphan remains':'removed','token bytes:',Buffer.byteLength(token));console.log(actual?'PROBLEM CONFIRMED':'PROBLEM NOT REPRODUCED');expect(actual).toBe(false);});
