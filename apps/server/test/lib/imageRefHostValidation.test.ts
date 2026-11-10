import {afterEach,expect,it,vi} from 'vitest';import {createService} from '@ninedeploy/schemas';
const dns=vi.hoisted(()=>({lookup:vi.fn(async()=>[{address:'93.184.216.34',family:4}])}));vi.mock('node:dns/promises',()=>({...dns,default:dns}));
const {parseImageRef}=await import('../../src/lib/imageRef.js');const {fetchImageDigest}=await import('../../src/lib/imageWatch.js');
afterEach(()=>vi.unstubAllGlobals());
async function inspect(image:string,probe=true){const input=createService.parse({name:'Fixture',type:'docker',image}).image!;dns.lookup.mockClear();const urls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(input:string|URL)=>{urls.push(new URL(String(input)).href);return new Response('',{status:200,headers:{'docker-content-digest':`sha256:${'1'.repeat(64)}`}});}));const parsed=parseImageRef(input);let probeError:string|undefined;if(parsed&&probe){try{await fetchImageDigest(parsed.registry,parsed.repository,parsed.tag);}catch(error){probeError=error instanceof Error?error.message:String(error);}}return {parsed,urls,probeError,lookups:dns.lookup.mock.calls.length};}

const cases = [
  {
    "image": "ghcr.io/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "REGISTRY/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "localhost:5000/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "REGISTRY:5000/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "[2001:4860:4860::8888]:5000/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "registry.example.test:99999/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "ghcr.io?fixture=1/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "ghcr.io#fixture/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "ghcr.io\\extra/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "ghcr..io/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "-registry.example/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "registry_.example/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "ghcr.io:bad/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "[::1/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "bad%host.example/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "ghcr.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "ghcr.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "docker.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "docker.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "index.docker.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "index.docker.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "registry-1.docker.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "registry-1.docker.io/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "REGISTRY/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "REGISTRY/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "[2001:4860:4860::8888]:5000/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "[2001:4860:4860::8888]:5000/acme/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "reg--istry.example:0005000/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "[::ffff:192.0.2.1]:5000/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "example.test./web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "foo_bar.example/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "[:::]:5000/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "[::1%25eth0]:5000/web:v1",
    "kind": "host",
    "valid": false
  },
  {
    "image": "REGISTRY.EXAMPLE/web:v1",
    "kind": "host",
    "valid": true
  },
  {
    "image": "docker.io/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "docker.io/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "index.docker.io/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "index.docker.io/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  },
  {
    "image": "registry-1.docker.io/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": true
  },
  {
    "image": "registry-1.docker.io/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:v1",
    "kind": "length",
    "valid": false
  }
];
for(const row of cases)it(`native-verified ${row.valid?'accepted':'refused'} ${row.image}`,async()=>{const actual=await inspect(row.image,!row.valid);if(row.valid)expect(actual.parsed).not.toBeNull();else{expect(actual.parsed).toBeNull();expect(actual.urls).toEqual([]);expect(actual.lookups).toBe(0);expect(actual.probeError).toBeUndefined();}});
it('valid ordinary host still probes the exact v2 manifest path',async()=>{const actual=await inspect('ghcr.io/web:v1');expect(actual.urls).toEqual(['https://ghcr.io/v2/web/manifests/v1']);expect(actual.probeError).toBeUndefined();});
it('valid repository255 remains probeable even though the full name is longer',async()=>{const repository=`acme/${'a'.repeat(250)}`;const actual=await inspect(`ghcr.io/${repository}:v1`);expect(actual.parsed?.repository).toHaveLength(255);expect(actual.urls).toEqual([`https://ghcr.io/v2/${repository}/manifests/v1`]);expect(actual.probeError).toBeUndefined();});
