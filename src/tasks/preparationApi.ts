import type { Task } from '../../shared/contracts';
import type { JiraSyncView, PreparationCommand, PreparationDetail, UploadCommand } from '../../shared/jira-preparation';
import { read } from './api';
export type PreparationApi = {
 sync(requestId:string):Promise<JiraSyncView>;
 detail(taskId:string,signal?:AbortSignal):Promise<PreparationDetail>;
 command(value:PreparationCommand):Promise<Task>;
 upload(value:UploadCommand,file:File):Promise<Task>;
};
export const preparationApi:PreparationApi={
 async sync(requestId){return read(await fetch('/api/jira/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId})}));},
 async detail(taskId,signal){return read(await fetch(`/api/tasks/${encodeURIComponent(taskId)}/preparation`,{signal,cache:'no-store'}));},
 async command(value){return read(await fetch(`/api/tasks/${encodeURIComponent(value.taskId)}/preparation/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}));},
 async upload(value,file){return read(await fetch(`/api/tasks/${encodeURIComponent(value.taskId)}/documents/${value.role}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Symphony-Request-Id':value.requestId,'X-Symphony-Expected-Revision':String(value.expectedRevision),'X-Symphony-Filename':encodeURIComponent(value.filename)},body:file}));},
};
