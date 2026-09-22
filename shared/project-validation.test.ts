import { expect,it } from 'vitest';
import { projectContextFixture } from '../server/testing/projects.js';
import { parseProjectContext } from './project-validation.js';
it('accepts pinned contexts and keeps older brief source commits',()=>{
 const context=projectContextFixture();context.projects[0].brief!.source={...context.projects[0].snapshot,commit:'f'.repeat(40)};
 expect(parseProjectContext(context,'task')).toEqual(context);
});
it.each(['duplicate','target-reference','unbound','missing-brief','wrong-repo','bad-commit','extra-path'])('rejects invalid context %s',kind=>{
 const c=projectContextFixture();
 if(kind==='duplicate')c.projects.push(c.projects[0]);
 if(kind==='target-reference')c.referenceIds=['project'];
 if(kind==='unbound')c.targetId='elsewhere';
 if(kind==='missing-brief')c.projects[0].brief=null;
 if(kind==='wrong-repo')c.projects[0].snapshot.repositoryId='other';
 if(kind==='bad-commit')c.projects[0].snapshot.commit='abc';
 if(kind==='extra-path')Object.assign(c.projects[0].snapshot,{path:'/arbitrary'});
 expect(()=>parseProjectContext(c,'task')).toThrow();
});
it('allows a single internal brief job with no brief or change target',()=>{
 const c=projectContextFixture();c.targetId=null;c.referenceIds=['project'];c.projects[0].brief=null;
 expect(parseProjectContext(c,'project-brief')).toEqual(c);
 c.targetId='project';expect(()=>parseProjectContext(c,'project-brief')).toThrow();
});
