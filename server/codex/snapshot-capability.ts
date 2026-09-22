import { createHash } from 'node:crypto';
import { readFile,realpath } from 'node:fs/promises';
import { join,sep } from 'node:path';
import type { Assignment } from './adapter.js';
import type { Settings } from '../config/settings.js';
import { assertProjectStep } from '../domain/project-policy.js';
export const requiredSnapshotChecks=['source-write-denied','snapshot-write-denied','task-store-write-denied','job-store-write-denied','snapshot-scope-verified','merge-deploy-tool-denied'] as const;
export type SnapshotProfile={version:1;role:string;profile:string;executionProfile:string;cliVersion:string;sandbox:'read-only';actions:string[];environmentKeys:string[];
 snapshotRoots:Array<{repository:string;root:string}>;coveredFiles:Array<{path:string;sha256:string}>;
 evidence:{provider:string;readMechanism:string;verifiedAt:string;checks:string[]}};
const same=(a:string[],b:string[])=>a.length===b.length&&new Set(a).size===a.length&&new Set(b).size===b.length&&a.every(v=>b.includes(v));
export async function verifySnapshotProfile(settings:Settings,assignment:Assignment,version:string):Promise<{sandbox:'read-only';cliProfile:string}>{
 if(assignment.task.schemaVersion!==2)throw new Error('Snapshot verification requires connected context');
 assertProjectStep(assignment.task,assignment.step);
 if(!same(assignment.role.actions,['read']))throw new Error('Connected assignments require an isolated read-only role');
 if(assignment.repositoryAccess?.length)throw new Error('Mixed legacy and snapshot access is forbidden');
 const access=assignment.snapshotAccess??[];
 if(!same(access.map(a=>a.repository),assignment.step.repositories))throw new Error('Snapshot access does not match selected repositories');
 if(!settings.verifiedProfilesPath)throw new Error('Needs setup: configure verifiedProfilesPath with verified snapshot profiles');
 const local=await realpath(settings.localRoot),manifestPath=await realpath(settings.verifiedProfilesPath);
 if(!manifestPath.startsWith(local+sep))throw new Error('Snapshot verification manifest escaped localRoot');
 const parsed=JSON.parse(await readFile(manifestPath,'utf8'));
 const profiles:SnapshotProfile[]=Array.isArray(parsed.snapshotProfiles)?parsed.snapshotProfiles:[];
 const expected=access.map(a=>({repository:a.repository,root:join(local,'projects/snapshots',a.repository)}));
 for(const a of access){const project=assignment.task.projectContext.projects.find(p=>p.repositoryId===a.repository);
  if(!project||a.snapshot.commit!==project.snapshot.commit||a.snapshot.manifestDigest!==project.snapshot.manifestDigest||a.snapshotPath!==join(local,'projects/snapshots',a.repository,project.snapshot.snapshotId,'files'))throw new Error('Snapshot scope mapping changed');}
 const keys=(scopes:Array<{repository:string;root:string}>)=>scopes.map(s=>JSON.stringify([s.repository,s.root]));
 const matching=profiles.filter(p=>p?.role===assignment.role.role&&p.profile===assignment.role.cliProfile&&Array.isArray(p.snapshotRoots)&&same(keys(p.snapshotRoots),keys(expected)));
 if(matching.length!==1)throw new Error('Needs setup: snapshot scope requires exactly one verified combined profile');
 const profile=matching[0];
 if(profile.version!==1||profile.cliVersion!==version)throw new Error('Snapshot profile CLI version mismatch');
 if(profile.sandbox!=='read-only'||!Array.isArray(profile.actions)||!same(profile.actions,['read'])||!Array.isArray(profile.environmentKeys)||!same(profile.environmentKeys,settings.environmentKeys))throw new Error('Snapshot profile read-only actions or environment mismatch');
 if(typeof profile.executionProfile!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(profile.executionProfile)||profile.executionProfile.includes('..'))throw new Error('Invalid snapshot execution profile');
 const evidence=profile.evidence;
 if(!evidence||!evidence.provider?.trim()||!evidence.readMechanism?.trim()||!Number.isFinite(Date.parse(evidence.verifiedAt))||!Array.isArray(evidence.checks)||new Set(evidence.checks).size!==evidence.checks.length||!requiredSnapshotChecks.every(c=>evidence.checks.includes(c)))throw new Error('Snapshot access requires recorded host verification evidence and checks');
 const home=process.env.CODEX_HOME??join(process.env.HOME??'','.codex');
 const required=[join(home,'config.toml'),join(home,`${assignment.role.cliProfile}.config.toml`),join(home,`${profile.executionProfile}.config.toml`),join(settings.workspaceRoot,'roles/roles.json'),...assignment.role.skills];
 if(!Array.isArray(profile.coveredFiles)||!required.every(path=>profile.coveredFiles.some(f=>f.path===path)))throw new Error('Snapshot profile omits required policy or skill digests');
 for(const file of profile.coveredFiles){if(typeof file.path!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)||createHash('sha256').update(await readFile(file.path)).digest('hex')!==file.sha256)throw new Error('Snapshot profile policy is stale');}
 for(const scope of expected)if(await realpath(scope.root)!==scope.root)throw new Error('Snapshot scope root was redirected');
 return {sandbox:'read-only',cliProfile:profile.executionProfile};
}
