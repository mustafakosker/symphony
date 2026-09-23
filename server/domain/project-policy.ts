import type { AgentStep,Run,Task,Workflow } from '../../shared/contracts.js';
export function assertProjectStep(task:Task,step:AgentStep):void{
 if(task.schemaVersion!==2)return;
 if(step.actions.length!==1||step.actions[0]!=='read')throw new Error('Connected projects are read-only');
 const allowed=new Set(task.projectContext.projects.map(p=>p.repositoryId));
 if(new Set(step.repositories).size!==step.repositories.length||step.repositories.some(id=>!allowed.has(id)))throw new Error('Workflow selected an unbound or duplicate repository');
}
export function assertProjectWorkflow(task:Task,workflow:Workflow):void{
 for(const step of workflow.steps)if(step.kind==='agent')assertProjectStep(task,step);
}
export function assertProjectRun(task:Task,step:AgentStep,run:Run):void{
 if(task.schemaVersion!==2)return;assertProjectStep(task,step);
 if(run.stepId!==step.id||run.repos.length!==step.repositories.length||new Set(run.repos.map(r=>r.repository)).size!==run.repos.length)throw new Error('Run repository context differs from bound task');
 for(const ref of run.repos){const p=task.projectContext.projects.find(p=>p.repositoryId===ref.repository);
  if(!p||!step.repositories.includes(ref.repository)||ref.commit!==p.snapshot.commit||ref.rule!==p.ref||ref.selectedCommits.length!==1||ref.selectedCommits[0]!==p.snapshot.commit)throw new Error('Run changed its pinned repository context');}
}
