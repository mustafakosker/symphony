import { expect,it } from 'vitest';
import { draftTask,workflowProposal } from '../testing/fixtures.js';
import { projectContextFixture } from '../testing/projects.js';
import { assertProjectStep,assertProjectWorkflow } from './project-policy.js';
import { eligibleStep,reduceTask } from './workflow.js';
import { parseTask } from '../../shared/validate.js';
import type { ConnectedTask,AgentStep } from '../../shared/contracts.js';
const connected=():ConnectedTask=>({...draftTask(),schemaVersion:2,purpose:'task',projectContext:projectContextFixture()});
it('parses schema2 without altering schema1 and gives triage the pinned repositories',()=>{
 const task=connected();expect(parseTask(task)).toEqual(task);expect(parseTask(draftTask())).toEqual(draftTask());
 expect(eligibleStep(task)?.repositories).toEqual(['project']);
 expect(()=>parseTask({...task,projectId:'other'})).toThrow();
});
it.each(['write-local','open-pr','merge','deploy'])('rejects %s even with approval',action=>{
 const task=connected(),step={...workflowProposal().steps[0],repositories:['project'],actions:[action]} as AgentStep;
 expect(()=>assertProjectStep(task,step)).toThrow(/read-only/);
 expect(()=>assertProjectWorkflow(task,{version:1,steps:[step],completionChecks:[]})).toThrow();
});
it('rejects foreign and duplicate repository selections',()=>{
 const step=workflowProposal().steps[0] as AgentStep;
 for(const repositories of [['other'],['project','project']])expect(()=>assertProjectStep(connected(),{...step,repositories})).toThrow(/repository/);
});
it('checks a human-approved proposal before transitioning to a running workflow',()=>{
 const task=connected();task.status='waiting-for-human';task.proposedWorkflow=workflowProposal();
 (task.proposedWorkflow.steps[0] as AgentStep).repositories=['unbound'];
 task.reviews=[{id:'review',kind:'workflow',workflowVersion:1,stepId:'$triage',artifacts:[],prompt:'Review',answer:null,decision:null}];
 expect(()=>reduceTask(task,{kind:'human',command:{requestId:'approve',taskId:task.id,expectedRevision:1,action:{kind:'approve',reviewId:'review',artifactDigests:[]}}},task.updatedAt)).toThrow(/repository/);
});
