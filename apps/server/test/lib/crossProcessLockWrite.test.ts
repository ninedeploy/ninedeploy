import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(()=>({short:0,schedule:[] as number[], offsets:[] as number[], closed:new Set<number>(), lastFd:-1}));
vi.mock('node:fs',async original=>{const actual=await original<typeof import('node:fs')>();return {...actual,
 closeSync:(fd:number)=>{state.closed.add(fd);return actual.closeSync(fd);},
 writeSync:((...args:Parameters<typeof actual.writeSync>)=>{const [fd,data,offset,length,position]=args as unknown as [number,string|Buffer,number,number,number];state.lastFd=fd;state.offsets.push(typeof data==='string'?0:offset);
 const remaining=typeof data==='string'?Buffer.byteLength(data):length;const limit=state.schedule.length?state.schedule.shift()!:state.short||remaining;
 if(limit<0)throw Object.assign(new Error('injected identity write failure'),{code:'ENOSPC'});
 return typeof data==='string'?actual.writeSync(fd,data.slice(0,limit)):actual.writeSync(fd,data,offset,Math.min(length,limit),position);}) as typeof actual.writeSync};});
const {acquireCrossProcessLock}=await import('../../src/lib/crossProcessLock.js');
const roots:string[]=[];const holders:Awaited<ReturnType<typeof acquireCrossProcessLock>>[]=[];
async function acquire(target:string){const holder=await acquireCrossProcessLock(target);holders.push(holder);return holder;}

function file(){const root=path.resolve(mkdtempSync(path.join(tmpdir(),'nd-lock-identity-audit-')));roots.push(root);return path.join(root,'operation.lock');}
afterEach(()=>{for(const holder of holders.splice(0))holder.release();state.short=0;state.schedule=[];state.offsets=[];state.closed.clear();state.lastFd=-1;for(const root of roots.splice(0)){if(!root.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(root).startsWith('nd-lock-identity-audit-'))throw new Error('Unowned cleanup');rmSync(root,{recursive:true,force:true});}});

for(const size of [1,2,3,7,1024])it(`completes native identity writes limited to ${size} bytes`,async()=>{const target=file();state.short=size;const holder=await acquire(target);const token=readFileSync(target,'utf8');expect(token).toMatch(/^\d+ \d+ [a-f0-9-]+\n$/);holder.release();expect(existsSync(target)).toBe(false);expect(state.closed.has(state.lastFd)).toBe(true);});
it('advances the buffer offset through uneven native writes',async()=>{const target=file();state.schedule=[2,1,4];const holder=await acquire(target);expect(state.offsets).toEqual([0,2,3,7]);expect(readFileSync(target,'utf8')).toMatch(/^\d+ \d+ [a-f0-9-]+\n$/);holder.release();expect(existsSync(target)).toBe(false);});
it('late old release preserves a later holder after the replacement barrier',async()=>{const target=file();state.short=3;const old=await acquire(target);unlinkSync(target);writeFileSync(target,'new-owner-token\n');old.release();expect(readFileSync(target,'utf8')).toBe('new-owner-token\n');});
it('double release cannot delete a newly acquired owner',async()=>{const target=file();state.short=2;const old=await acquire(target);old.release();const current=await acquire(target);const token=readFileSync(target,'utf8');old.release();expect(readFileSync(target,'utf8')).toBe(token);current.release();expect(existsSync(target)).toBe(false);});
it('zero progress refuses ownership and closes the native descriptor',async()=>{const target=file();state.schedule=[0];await expect(acquire(target)).rejects.toThrow('made no progress');expect(state.closed.has(state.lastFd)).toBe(true);});
it('failure after a native partial write propagates and closes the descriptor',async()=>{const target=file();state.schedule=[3,-1];await expect(acquire(target)).rejects.toThrow('injected identity write failure');expect(state.closed.has(state.lastFd)).toBe(true);});
