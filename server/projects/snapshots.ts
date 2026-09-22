import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile, lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProjectRecord, SnapshotEntry, SnapshotLimits, SnapshotManifest, SnapshotRef } from '../../shared/projects.js';
import { BoundaryError } from '../../shared/validate.js';
import { confinedPath } from '../store/paths.js';
import { runGit,gitConfig,gitEnvironment } from './git.js';
import { validateSource } from './discovery.js';
type Resolved={commit:string;objectFormat:'sha1'|'sha256'};
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const id=(repository:string,commit:string)=>hash(JSON.stringify([repository,commit]));
const text=(bytes:Uint8Array)=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
const validId=(value:string)=>/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
export function assertSourcePath(path:string):void{
 if(!path||path.startsWith('/')||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git'))throw new BoundaryError('invalid','Invalid repository-relative source path');
}
export async function resolveSourceCommit(project:ProjectRecord,ref:string):Promise<Resolved>{
 if(!project.branches.includes(ref))throw new BoundaryError('invalid','Select an available project branch');
 await validateSource(dirname(project.sourcePath),project.sourcePath);
 const commit=(await runGit(project.sourcePath,['rev-parse','--verify','--end-of-options',`refs/heads/${ref}^{commit}`])).toString().trim();
 const objectFormat=(await runGit(project.sourcePath,['rev-parse','--show-object-format'])).toString().trim();
 if(!['sha1','sha256'].includes(objectFormat)||!new RegExp(`^[a-f0-9]{${objectFormat==='sha1'?40:64}}$`).test(commit))throw new BoundaryError('invalid','Unsupported Git object identity');
 return {commit,objectFormat:objectFormat as Resolved['objectFormat']};
}
export type SnapshotService={importCommit(project:ProjectRecord,resolved:Resolved):Promise<void>;
 materialize(project:ProjectRecord,resolved:Resolved):Promise<SnapshotRef>;verify(ref:SnapshotRef):Promise<SnapshotManifest>;
 readText(ref:SnapshotRef,path:string):Promise<{text:string;entry:SnapshotEntry}>;path(ref:SnapshotRef):Promise<string>};
async function transfer(source:string,destination:string,objects:string,limits:SnapshotLimits):Promise<void>{
 await new Promise<void>((resolve,reject)=>{
  const pack=spawn('git',[...gitConfig,'pack-objects','--stdout'],{cwd:source,env:gitEnvironment,stdio:['pipe','pipe','pipe']});
  const index=spawn('git',[...gitConfig,'index-pack','--stdin'],{cwd:destination,env:gitEnvironment,stdio:['pipe','pipe','pipe']});
  let closed=0,error:Error|null=null,bytes=0;
  const fail=(cause:Error)=>{error??=cause;pack.kill('SIGKILL');index.kill('SIGKILL');};
  const timer=setTimeout(()=>fail(new Error('Git object import timed out')),limits.timeoutMs);
  for(const child of [pack,index]){
   child.on('error',fail);child.stdin.on('error',()=>{});child.stderr.resume();
   child.on('close',code=>{if(code!==0)fail(new Error('Committed Git objects could not be imported'));
    if(++closed===2){clearTimeout(timer);error?reject(error):resolve();}});
  }
  index.stdout.resume();pack.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>limits.totalBytes+limits.entries*512+1048576)fail(new Error('Git object import exceeds snapshot limit'));});
  pack.stdout.pipe(index.stdin);pack.stdin.end(objects);
 });
}
export async function openSnapshots(localRoot:string,limits:SnapshotLimits):Promise<SnapshotService>{
 for(const n of Object.values(limits))if(!Number.isSafeInteger(n)||n<=0)throw new Error('Snapshot limits must be positive integers');
 const root=await confinedPath(localRoot,'projects/snapshots');await mkdir(root,{recursive:true});
 const queues=new Map<string,Promise<unknown>>();
 const serial=<T>(key:string,fn:()=>Promise<T>):Promise<T>=>{const next=(queues.get(key)??Promise.resolve()).catch(()=>{}).then(fn);queues.set(key,next);return next;};
 async function objects(project:ProjectRecord,resolved:Resolved){
  if(!validId(project.repositoryId)||!validId(project.id))throw new Error('Invalid project identity');
  const path=await confinedPath(localRoot,`projects/objects/${project.repositoryId}`);await mkdir(path,{recursive:true});
  try{await lstat(join(path,'HEAD'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await runGit(path,['init','--bare',`--object-format=${resolved.objectFormat}`]);}
  return path;
 }
 async function path(ref:SnapshotRef){
  if(!validId(ref.repositoryId)||!validId(ref.projectId)||!['sha1','sha256'].includes(ref.objectFormat)||
   !new RegExp(`^[a-f0-9]{${ref.objectFormat==='sha1'?40:64}}$`).test(ref.commit)||ref.snapshotId!==id(ref.repositoryId,ref.commit)||!/^[a-f0-9]{64}$/.test(ref.manifestDigest))throw new BoundaryError('invalid','Invalid snapshot identity');
  return confinedPath(root,ref.snapshotId);
 }
 async function verify(ref:SnapshotRef):Promise<SnapshotManifest>{
  const directory=await path(ref),manifestPath=await confinedPath(directory,'manifest.json');
  const bytes=await readFile(manifestPath);if(hash(bytes)!==ref.manifestDigest)throw new BoundaryError('conflict','Snapshot manifest digest changed');
  const manifest:SnapshotManifest=JSON.parse(text(bytes)),{manifestDigest,...expected}=ref;
  if((!manifest.ref||Object.keys(manifest.ref).length!==Object.keys(expected).length||Object.entries(expected).some(([key,value])=>manifest.ref[key as keyof typeof expected]!==value))||manifest.version!==1||!Array.isArray(manifest.entries))throw new Error('Snapshot manifest identity mismatch');
  const wanted=new Set<string>();let total=0;
  for(const entry of manifest.entries){
   assertSourcePath(entry.path);
   if(entry.kind!=='file')continue;
   if(wanted.has(entry.path))throw new Error('Duplicate snapshot path');wanted.add(entry.path);
   const file=await confinedPath(directory,`files/${entry.path}`),info=await lstat(file);
   if(!info.isFile()||info.size!==entry.bytes||info.size>limits.fileBytes)throw new Error('Snapshot file changed or exceeds limit');
   if(hash(await readFile(file))!==entry.contentDigest)throw new BoundaryError('conflict','Snapshot file digest changed');
   total+=info.size;
  }
  const found:string[]=[];
  async function visit(relative:string):Promise<void>{for(const name of await readdir(join(directory,'files',relative))){const child=relative?`${relative}/${name}`:name;
   const file=await confinedPath(directory,`files/${child}`),info=await lstat(file);if(info.isDirectory())await visit(child);else if(info.isFile())found.push(child);else throw new Error('Unsupported snapshot entry');}}
  await visit('');
  if(found.length!==wanted.size||found.some(file=>!wanted.has(file))||total!==manifest.totalBytes||total>limits.totalBytes||manifest.entries.length>limits.entries)throw new Error('Snapshot manifest contents or limits differ');
  return manifest;
 }
 return {
  path,verify,
  importCommit:(project,resolved)=>serial(project.repositoryId,async()=>{
   const owned=await objects(project,resolved);
   try{await runGit(owned,['cat-file','-e',`${resolved.commit}^{tree}`]);return;}catch{/* Import missing objects from the validated source. */}
   await validateSource(dirname(project.sourcePath),project.sourcePath,limits.timeoutMs);
   const treeObjects=await runGit(project.sourcePath,['rev-list','--objects','--no-object-names',`${resolved.commit}^{tree}`],{timeoutMs:limits.timeoutMs,maxBytes:limits.entries*150+1048576});
   await transfer(project.sourcePath,owned,`${resolved.commit}\n${treeObjects.toString()}`,limits);
   await runGit(owned,['cat-file','-e',`${resolved.commit}^{tree}`]);
   await runGit(owned,['update-ref',`refs/symphony/${resolved.commit}`,resolved.commit]);
  }),
  materialize:(project,resolved)=>serial(project.repositoryId,async()=>{
   const owned=await objects(project,resolved),snapshotId=id(project.repositoryId,resolved.commit);
   const base={projectId:project.id,repositoryId:project.repositoryId,commit:resolved.commit,objectFormat:resolved.objectFormat,snapshotId};
   const listing=await runGit(owned,['ls-tree','-r','-l','-z',resolved.commit],{timeoutMs:limits.timeoutMs,maxBytes:limits.entries*1024+1024});
   const raw=text(listing).split('\0').filter(Boolean);if(raw.length>limits.entries)throw new Error(`Snapshot entry limit ${limits.entries} exceeded`);
   const temporary=await confinedPath(root,`staging-${randomUUID()}`);await mkdir(join(temporary,'files'),{recursive:true});
   const entries:SnapshotEntry[]=[],seen=new Set<string>();let totalBytes=0;
   try{
    for(const line of raw){
     const tab=line.indexOf('\t'),[mode,kind,objectId,size]=line.slice(0,tab).trim().split(/\s+/),name=line.slice(tab+1);assertSourcePath(name);
     const key=name.normalize('NFC').toLowerCase();if(seen.has(key))throw new Error('Source filename collision cannot be materialized');seen.add(key);
     const entry:SnapshotEntry={path:name,mode,kind:mode==='120000'?'symlink':kind==='commit'?'submodule':'file',objectId,contentDigest:null,bytes:0,text:false,lfsPointer:false};
     if(entry.kind==='file'){
      const count=Number(size);if(!Number.isSafeInteger(count)||count<0||count>limits.fileBytes||totalBytes+count>limits.totalBytes)throw new Error(`Snapshot byte/file limit exceeded by ${name}`);
      const bytes=await runGit(owned,['cat-file','blob',objectId],{timeoutMs:limits.timeoutMs,maxBytes:limits.fileBytes});
      entry.bytes=bytes.length;totalBytes+=bytes.length;entry.contentDigest=hash(bytes);
      try{const decoded=text(bytes);entry.text=!decoded.includes('\0');entry.lfsPointer=decoded.startsWith('version https://git-lfs.github.com/spec/v1\n');}catch{entry.text=false;}
      const destination=await confinedPath(temporary,`files/${name}`);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,bytes,{flag:'wx',mode:0o444});
     }
     entries.push(entry);
    }
    const manifest:SnapshotManifest={version:1,ref:base,entries,totalBytes},bytes=Buffer.from(JSON.stringify(manifest));
    const ref:SnapshotRef={...base,manifestDigest:hash(bytes)},destination=await path(ref);
    try{await verify(ref);return ref;}catch{/* Rebuild only these retained committed bytes. */}
    await writeFile(join(temporary,'manifest.json'),bytes,{flag:'wx',mode:0o444});
    await rm(destination,{recursive:true,force:true});await rename(temporary,destination);await verify(ref);return ref;
   }finally{await rm(temporary,{recursive:true,force:true});}
  }),
  readText:async(ref,name)=>{
   assertSourcePath(name);const manifest=await verify(ref),entry=manifest.entries.find(e=>e.path===name);
   if(!entry||entry.kind!=='file'||!entry.text)throw new BoundaryError('invalid','Source is not an available text file');
   const file=await confinedPath(await path(ref),`files/${name}`),bytes=await readFile(file);
   if(hash(bytes)!==entry.contentDigest)throw new BoundaryError('conflict','Source changed during preview');return {text:text(bytes),entry};
  },
 };
}
