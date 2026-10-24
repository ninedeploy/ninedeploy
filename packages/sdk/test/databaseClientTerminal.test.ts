import {describe,it,expect,vi,afterEach} from 'vitest';
import {createClient} from '../src/index.js';
afterEach(()=>vi.restoreAllMocks());
const input={target:{kind:'database' as const,databaseId:7,mode:'client' as const}};
describe('database client preparation request budget',()=>{
  it('allows the bounded sealed node capability and immutable target preparation',async()=>{
    const timeout=vi.spyOn(AbortSignal,'timeout'),fetcher=vi.fn(async()=>({ok:true,status:201,text:async()=> '{}'}));
    await createClient({baseUrl:'https://owned.example',fetch:fetcher}).terminals.create(input);
    expect(timeout).toHaveBeenLastCalledWith(60_000);expect(fetcher).toHaveBeenCalledWith('https://owned.example/v1/terminals',expect.objectContaining({method:'POST',body:JSON.stringify(input)}));
  });
  it('preserves a larger explicit budget and an explicitly disabled timeout',async()=>{
    const timeout=vi.spyOn(AbortSignal,'timeout'),fetcher=vi.fn(async()=>({ok:true,status:201,text:async()=> '{}'}));
    await createClient({baseUrl:'https://owned.example',fetch:fetcher,timeoutMs:120_000}).terminals.create(input);expect(timeout).toHaveBeenLastCalledWith(120_000);
    timeout.mockClear();await createClient({baseUrl:'https://owned.example',fetch:fetcher,timeoutMs:0}).terminals.create(input);expect(timeout).not.toHaveBeenCalled();
  });
  it('retains the normal request timeout for database shells and service terminals',async()=>{
    const timeout=vi.spyOn(AbortSignal,'timeout'),fetcher=vi.fn(async()=>({ok:true,status:201,text:async()=> '{}'}));
    const client=createClient({baseUrl:'https://owned.example',fetch:fetcher});await client.terminals.create({target:{kind:'database',databaseId:7,mode:'shell'}});expect(timeout).toHaveBeenLastCalledWith(30_000);
    await client.terminals.create({target:{kind:'service',serviceId:7}});expect(timeout).toHaveBeenLastCalledWith(30_000);
  });
});
