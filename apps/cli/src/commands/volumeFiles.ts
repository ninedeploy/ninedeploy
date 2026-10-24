import { open, writeFile } from 'node:fs/promises';
import { managedVolumeName } from '@ninedeploy/schemas';
import type { NineDeployClient } from '../client.js';
import { error, info, success, table } from '../lib/format.js';
import { prompt } from '../prompts.js';

export interface VolumeFileOptions { server?: string; json?: boolean; file?: string; output?: string; force?: boolean; yes?: boolean }
function target(name: string, raw: string, options: VolumeFileOptions, root = false) {
  managedVolumeName.parse(name);
  if (options.server !== undefined && (!/^[1-9]\d*$/.test(options.server) || !Number.isSafeInteger(Number(options.server)))) throw Error('--server must be a positive decimal node id');
  if (raw.startsWith('/') || /[\0\r\n]/.test(raw) || raw.length > 2048) throw Error('Use a relative path inside the volume');
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw Error('Path escapes the volume'); parts.pop(); }
    else parts.push(part);
  }
  const path = parts.join('/');
  if (!path && !root) throw Error('A path inside the volume is required');
  const host: [] | [{serverId:number}] = options.server === undefined ? [] : [{serverId:Number(options.server)}];
  return {path,host};
}
const fail=(err:unknown)=>error(err instanceof Error?err.message:String(err));
export async function volumeFilesList(client: NineDeployClient,name:string,path='',options:VolumeFileOptions={}) {
  try {
    const selected=target(name,path,options,true),result=await client.volumes.listFiles(name,selected.path,...selected.host);
    if(options.json)console.log(JSON.stringify(result));
    else if(!result.entries.length)info('Empty directory.');
    else table(result.entries.map(entry=>({name:entry.name,type:entry.type,size:entry.sizeBytes})),['name','type','size']);
  }catch(err){fail(err);}
}
export async function volumeFileRead(client:NineDeployClient,name:string,path:string,options:VolumeFileOptions={}) {
  try {
    const selected=target(name,path,options),result=await client.volumes.readFile(name,selected.path,...selected.host);
    const bytes=Buffer.from(result.content,result.encoding==='base64'?'base64':'utf8');
    if(options.output){await writeFile(options.output,bytes,{flag:options.force?'w':'wx'});success(`Saved ${bytes.length} bytes to ${options.output}`);}
    else process.stdout.write(bytes);
  }catch(err){fail(err);}
}
export async function volumeFileWrite(client:NineDeployClient,name:string,path:string,options:VolumeFileOptions={}) {
  try {
    const selected=target(name,path,options);
    if(!options.file)throw Error('--file <local-file> is required');
    const input=await open(options.file,'r');let bytes:Buffer;
    try {
      if(!(await input.stat()).isFile())throw Error('--file must name a regular file');
      const buffer=Buffer.alloc(1024*1024+1);let length=0;
      while(length<buffer.length){const read=await input.read(buffer,length,buffer.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}
      if(length>1024*1024)throw Error('File exceeds the 1 MiB editor limit');
      bytes=buffer.subarray(0,length);
    }finally{await input.close();}
    await client.volumes.writeFile(name,{path:selected.path,contentBase64:bytes.toString('base64')},...selected.host);
    success(`Wrote ${bytes.length} bytes to ${name}:${selected.path}${options.server?` on node #${options.server}`:''}`);
  }catch(err){fail(err);}
}
export async function volumeFileMkdir(client:NineDeployClient,name:string,path:string,options:VolumeFileOptions={}) {
  try {const selected=target(name,path,options);await client.volumes.mkdir(name,{path:selected.path},...selected.host);success('Directory created');}catch(err){fail(err);}
}
export async function volumeFileDelete(client:NineDeployClient,name:string,path:string,options:VolumeFileOptions={}) {
  try {
    const selected=target(name,path,options);
    if(!options.yes){const answer=await prompt(`Type ${selected.path} to delete it recursively from ${name}${options.server?` on node #${options.server}`:''}`);if(answer!==selected.path)return error('Cancelled.');}
    await client.volumes.deleteFile(name,selected.path,...selected.host);success('Volume path deleted');
  }catch(err){fail(err);}
}
