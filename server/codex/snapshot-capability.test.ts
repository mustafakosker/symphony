import { afterEach,expect,it } from 'vitest';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createProjectFixture,projectContextFixture } from '../testing/projects.js';
import { draftTask } from '../testing/fixtures.js';
import { verifySnapshotProfile,requiredSnapshotChecks } from './snapshot-capability.js';
import type { Assignment } from './adapter.js';
import type { Settings } from '../config/settings.js';
const cleanups:Array<()=>Promise<void>>=[],old=process.env.CODEX_HOME;
afterEach(async()=>{if(old===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=old;for(const c of cleanups.splice(0))await c();});
async function setup(){const f=await createProjectFixture();cleanups.push(f.dispose);const home=join(f.base,'codex');await mkdir(home);process.env.CODEX_HOME=home;
 await mkdir(join(f.workspace,'roles'));const coveredFiles=[];
 for(const path of [join(home,'config.toml'),join(home,'researcher.config.toml'),join(f.workspace,'roles/roles.json')]){await writeFile(path,'policy');coveredFiles.push({path,sha256:createHash('sha256').update('policy').digest('hex')});}
 const context=projectContextFixture();context.projects[0].brief=null;context.targetId=null;context.referenceIds=['project'];
 const task={...draftTask(),schemaVersion:2 as const,purpose:'project-brief' as const,projectContext:context};
 const scopeRoot=join(f.local,'projects/snapshots/project');await mkdir(scopeRoot,{recursive:true});
 const assignment:Assignment={task,cwd:f.local,outputDir:f.local,schemaPath:join(f.local,'schema.json'),materials:[],repositoryAccess:[],
  snapshotAccess:[{kind:'snapshot',repository:'project',snapshot:context.projects[0].snapshot,snapshotPath:join(scopeRoot,context.projects[0].snapshot.snapshotId,'files')}],
  step:{kind:'agent',id:'brief',title:'Brief',role:'researcher',instructions:'Read',inputs:[],repositories:['project'],actions:['read'],outputs:[],checks:[]},
  role:{role:'researcher',instructions:'Read',skills:[],cliProfile:'researcher',actions:['read']},
  run:{id:'run',stepId:'brief',workflowVersion:1,generation:1,phase:'launch-intent',pid:null,processStartedAt:null,runtimeVersion:'v1',inputRefs:[],repos:[],startedAt:task.createdAt,endedAt:null,exitCode:null,retryCount:0,nextRetryAt:null,result:null}};
 const profile={version:1,role:'researcher',profile:'researcher',executionProfile:'researcher',cliVersion:'v1',sandbox:'read-only',actions:['read'],environmentKeys:[],
  snapshotRoots:[{repository:'project',root:scopeRoot}],coveredFiles,evidence:{provider:'operator',readMechanism:'host-profile',verifiedAt:'2026-09-22T10:00:00Z',checks:[...requiredSnapshotChecks]}};
 const settings={workspaceRoot:f.workspace,localRoot:f.local,environmentKeys:[],verifiedProfilesPath:join(f.local,'verified.json')} as Settings;
 const save=(profiles=[profile])=>writeFile(settings.verifiedProfilesPath!,JSON.stringify({profiles:[],snapshotProfiles:profiles}));await save();
 return {...f,settings,assignment,profile,save};}
it('requires exact scope and current policy, without accepting duplicated or stale profiles',async()=>{
 const f=await setup();expect(await verifySnapshotProfile(f.settings,f.assignment,'v1')).toEqual({sandbox:'read-only',cliProfile:'researcher'});
 await expect(verifySnapshotProfile(f.settings,f.assignment,'v2')).rejects.toThrow(/version|mismatch/);
 await f.save([f.profile,f.profile]);await expect(verifySnapshotProfile(f.settings,f.assignment,'v1')).rejects.toThrow(/exactly one/);
 await f.save();await writeFile(f.profile.coveredFiles[0].path,'changed');await expect(verifySnapshotProfile(f.settings,f.assignment,'v1')).rejects.toThrow(/stale/);
});
it('does not combine two individual attestations to grant a multi-project assignment',async()=>{
 const f=await setup();f.assignment.step.repositories.push('other');
 f.assignment.snapshotAccess!.push({...f.assignment.snapshotAccess![0],repository:'other',snapshotPath:join(f.local,'projects/snapshots/other/id/files')});
 const second={...f.profile,snapshotRoots:[{repository:'other',root:join(f.local,'projects/snapshots/other')}]};
 await f.save([f.profile,second]);await expect(verifySnapshotProfile(f.settings,f.assignment,'v1')).rejects.toThrow();
});
it('rejects missing evidence, role action supersets, and mixed legacy access',async()=>{
 const f=await setup();f.profile.evidence.checks=[];await f.save();await expect(verifySnapshotProfile(f.settings,f.assignment,'v1')).rejects.toThrow(/evidence|checks/);
 f.profile.evidence.checks=[...requiredSnapshotChecks];await f.save();f.assignment.role.actions.push('write-local');await expect(verifySnapshotProfile(f.settings,f.assignment,'v1')).rejects.toThrow(/read-only/);
 f.assignment.role.actions=['read'];f.assignment.repositoryAccess=[{repository:'project',localPath:f.root,checkoutPath:null,mcpProfile:null,rule:'main',commit:'a'.repeat(40),selectedCommits:[]}];
 await expect(verifySnapshotProfile(f.settings,f.assignment,'v1')).rejects.toThrow(/mixed|legacy/);
});
it('accepts an explicitly verified combined scope and rejects an extra grant',async()=>{
 const f=await setup(),context=f.assignment.task.schemaVersion===2?f.assignment.task.projectContext:null;
 if(!context)throw new Error('Expected connected task');
 const extra={...context.projects[0],projectId:'other',repositoryId:'other',snapshot:{...context.projects[0].snapshot,projectId:'other',repositoryId:'other'}};
 context.projects.push(extra);context.referenceIds.push('other');f.assignment.step.repositories.push('other');
 const root=join(f.local,'projects/snapshots/other');await mkdir(root,{recursive:true});
 f.assignment.snapshotAccess!.push({kind:'snapshot',repository:'other',snapshot:extra.snapshot,snapshotPath:join(root,extra.snapshot.snapshotId,'files')});
 f.profile.snapshotRoots.push({repository:'other',root});await f.save();
 expect((await verifySnapshotProfile(f.settings,f.assignment,'v1')).sandbox).toBe('read-only');
 f.profile.snapshotRoots.push({repository:'extra',root:join(f.local,'projects/snapshots/extra')});await f.save();
 await expect(verifySnapshotProfile(f.settings,f.assignment,'v1')).rejects.toThrow(/exactly one/);
});
