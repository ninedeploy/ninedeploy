import {afterEach,expect,it,vi} from 'vitest';import {createService} from '@ninedeploy/schemas';
const dns=vi.hoisted(()=>({lookup:vi.fn(async()=>[{address:'93.184.216.34',family:4}])}));vi.mock('node:dns/promises',()=>({...dns,default:dns}));
const {parseImageRef}=await import('../../src/lib/imageRef.js');const {fetchImageDigest}=await import('../../src/lib/imageWatch.js');
afterEach(()=>vi.unstubAllGlobals());
async function inspect(image:string){const input=createService.parse({name:'Fixture',type:'docker',image}).image!;dns.lookup.mockClear();const urls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(input:string|URL)=>{urls.push(new URL(String(input)).href);return new Response('',{status:200,headers:{'docker-content-digest':`sha256:${'1'.repeat(64)}`}});}));const parsed=parseImageRef(input);if(parsed)await fetchImageDigest(parsed.registry,parsed.repository,parsed.tag);return {parsed,urls,lookups:dns.lookup.mock.calls.length};}

const cases = [
  {
    "image": "ghcr.io/acme/app__one--two.v3:v1_2.3-4",
    "valid": true,
    "kind": "repo",
    "expectedUrl": "https://ghcr.io/v2/acme/app__one--two.v3/manifests/v1_2.3-4"
  },
  {
    "image": "ghcr.io/acme/../../outside:v1",
    "valid": false,
    "kind": "repo",
    "expectedUrl": null
  },
  {
    "image": "ghcr.io/acme//app:v1",
    "valid": false,
    "kind": "repo",
    "expectedUrl": null
  },
  {
    "image": "ghcr.io/./app:v1",
    "valid": false,
    "kind": "repo",
    "expectedUrl": null
  },
  {
    "image": "ghcr.io/-app:v1",
    "valid": false,
    "kind": "repo",
    "expectedUrl": null
  },
  {
    "image": "ghcr.io/.app:v1",
    "valid": false,
    "kind": "repo",
    "expectedUrl": null
  },
  {
    "image": "ghcr.io/app_:v1",
    "valid": false,
    "kind": "repo",
    "expectedUrl": null
  },
  {
    "image": "ghcr.io/a___b:v1",
    "valid": false,
    "kind": "repo",
    "expectedUrl": null
  },
  {
    "image": "ghcr.io/a..b:v1",
    "valid": false,
    "kind": "repo",
    "expectedUrl": null
  },
  {
    "image": "ghcr.io/acme/:v1",
    "valid": false,
    "kind": "repo",
    "expectedUrl": null
  },
  {
    "image": "ghcr.io/app_v2:v1",
    "valid": true,
    "kind": "repo",
    "expectedUrl": "https://ghcr.io/v2/app_v2/manifests/v1"
  },
  {
    "image": "ghcr.io/app__v2:v1",
    "valid": true,
    "kind": "repo",
    "expectedUrl": "https://ghcr.io/v2/app__v2/manifests/v1"
  },
  {
    "image": "ghcr.io/app-v2:v1",
    "valid": true,
    "kind": "repo",
    "expectedUrl": "https://ghcr.io/v2/app-v2/manifests/v1"
  },
  {
    "image": "ghcr.io/app--v2:v1",
    "valid": true,
    "kind": "repo",
    "expectedUrl": "https://ghcr.io/v2/app--v2/manifests/v1"
  },
  {
    "image": "ghcr.io/app.v2:v1",
    "valid": true,
    "kind": "repo",
    "expectedUrl": "https://ghcr.io/v2/app.v2/manifests/v1"
  },
  {
    "image": "ghcr.io/acme/deep/web:v1",
    "valid": true,
    "kind": "repo",
    "expectedUrl": "https://ghcr.io/v2/acme/deep/web/manifests/v1"
  },
  {
    "image": "ghcr.io/acme/web:_valid",
    "valid": true,
    "kind": "tag",
    "expectedUrl": "https://ghcr.io/v2/acme/web/manifests/_valid"
  },
  {
    "image": "ghcr.io/acme/web:_",
    "valid": true,
    "kind": "tag",
    "expectedUrl": "https://ghcr.io/v2/acme/web/manifests/_"
  },
  {
    "image": "ghcr.io/acme/web:9",
    "valid": true,
    "kind": "tag",
    "expectedUrl": "https://ghcr.io/v2/acme/web/manifests/9"
  },
  {
    "image": "ghcr.io/acme/web:a.b-c_d",
    "valid": true,
    "kind": "tag",
    "expectedUrl": "https://ghcr.io/v2/acme/web/manifests/a.b-c_d"
  },
  {
    "image": "ghcr.io/acme/web:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "valid": true,
    "kind": "tag",
    "expectedUrl": "https://ghcr.io/v2/acme/web/manifests/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  {
    "image": "ghcr.io/acme/web:..",
    "valid": false,
    "kind": "tag",
    "expectedUrl": null
  },
  {
    "image": "ghcr.io/acme/web:-bad",
    "valid": false,
    "kind": "tag",
    "expectedUrl": null
  },
  {
    "image": "ghcr.io/acme/web:.bad",
    "valid": false,
    "kind": "tag",
    "expectedUrl": null
  },
  {
    "image": "ghcr.io/acme/web:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "valid": false,
    "kind": "tag",
    "expectedUrl": null
  },
  {
    "image": "ghcr.io/acme/web:",
    "valid": false,
    "kind": "tag",
    "expectedUrl": null
  }
];
for(const row of cases)it(`native-verified ${row.valid?'accepted':'refused'} ${row.image}`,async()=>{const result=await inspect(row.image);if(!row.valid){expect(result.parsed).toBeNull();expect(result.urls).toEqual([]);expect(result.lookups).toBe(0);}else{expect(result.parsed).not.toBeNull();expect(result.urls).toEqual([row.expectedUrl]);expect(result.lookups).toBeGreaterThan(0);}});
