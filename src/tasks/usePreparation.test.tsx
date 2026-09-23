// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { jiraTask } from '../../server/preparation/testing';
import type { Task } from '../../shared/contracts';
import type { PreparationDetail, PreparationCommand } from '../../shared/jira-preparation';
import { ApiError } from './api';
import { usePreparation } from './usePreparation';
import type { PreparationApi } from './preparationApi';
function deferred<T>(){let resolve!:(v:T)=>void;let reject!:(v:Error)=>void;const promise=new Promise<T>((y,n)=>{resolve=y;reject=n;});return{resolve,reject,promise};}
const mutateTask=(operation:()=>Promise<Task>)=>operation();
function apiFor(task:Task):PreparationApi{return {detail:async()=>({taskId:task.id,revision:task.revision,promptText:'saved'}),command:async()=>({...task,revision:task.revision+1}),upload:vi.fn(),sync:vi.fn()};}
afterEach(()=>{cleanup();vi.useRealTimers();});
it('preserves typing across late detail responses and Jira refresh',async()=>{
 const task=jiraTask(), detail=deferred<PreparationDetail>(), api={...apiFor(task),detail:vi.fn(()=>detail.promise)};
 const {result,rerender}=renderHook(({task})=>usePreparation({task,connected:true,api,mutateTask}),{initialProps:{task}});
 act(()=>result.current.setPromptText('my words'));
 await act(async()=>detail.resolve({taskId:task.id,revision:1,promptText:'old'}));
 rerender({task:{...task,revision:2,title:'Refreshed'}});expect(result.current.promptText).toBe('my words');expect(result.current.dirty).toBe(true);
});
it('replays the entire save envelope after response loss even when polling advances',async()=>{
 const task=jiraTask(),sent:PreparationCommand[]=[];let fail=true;
 const api={...apiFor(task),command:async(c:PreparationCommand)=>{sent.push(c);if(fail)throw new Error('Network lost');return {...task,revision:2};}};
 const {result,rerender}=renderHook(({task})=>usePreparation({task,connected:true,api,mutateTask}),{initialProps:{task}});
 await waitFor(()=>expect(result.current.promptText).toBe('saved'));act(()=>result.current.setPromptText(' exact '));
 await act(async()=>{expect(await result.current.save()).toBe(false);});
 rerender({task:{...task,revision:2}});fail=false;
 await act(async()=>{expect(await result.current.save()).toBe(true);});expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);
});
it('keeps typing during a save dirty and flushes it afterward',async()=>{
 const task=jiraTask(), gate=deferred<Task>(), sent:PreparationCommand[]=[];
 const api={...apiFor(task),command:async(c:PreparationCommand)=>{sent.push(c);return sent.length===1?gate.promise:{...task,revision:3};}};
 const {result}=renderHook(()=>usePreparation({task,connected:true,api,mutateTask}));await waitFor(()=>expect(result.current.promptText).toBe('saved'));
 act(()=>result.current.setPromptText('first'));let saving!:Promise<boolean>;act(()=>{saving=result.current.save();});act(()=>result.current.setPromptText('second'));
 await act(async()=>{gate.resolve({...task,revision:2});await saving;});expect(result.current.dirty).toBe(true);expect(result.current.promptText).toBe('second');
 await act(async()=>{await result.current.flush();});expect(sent[1].expectedRevision).toBe(2);expect(result.current.dirty).toBe(false);
});
it('requires explicit save after a conflict and retains upload errors until discard',async()=>{
 const task=jiraTask();const api={...apiFor(task),command:vi.fn(async():Promise<Task>=>{throw new ApiError('Changed',409);}),upload:vi.fn(async()=>{throw new ApiError('Wrong file',400);})};
 const {result,rerender}=renderHook(({task})=>usePreparation({task,connected:true,api,mutateTask}),{initialProps:{task}});await waitFor(()=>expect(result.current.promptText).toBe('saved'));
 act(()=>result.current.setPromptText('mine'));await act(async()=>{await result.current.save();});rerender({task:{...task,revision:2}});
 await new Promise(r=>setTimeout(r,550));expect(api.command).toHaveBeenCalledTimes(1);expect(result.current.promptText).toBe('mine');
 api.command.mockImplementation(async()=>({...task,revision:3}));await act(async()=>{await result.current.save();});
 await act(async()=>{await result.current.upload('design',new File(['x'],'x.md'));});expect(result.current.uploadError.design).toBeTruthy();
 await act(async()=>{expect(await result.current.send()).toBe(false);});act(()=>result.current.discardUploadError('design'));expect(result.current.uploadError.design).toBeUndefined();
});
it('aborts old detail on task switch, blocks disconnect and duplicate send',async()=>{
 const task=jiraTask(),gate=deferred<Task>(),signals:AbortSignal[]=[];const api={...apiFor(task),detail:async(id:string,signal?:AbortSignal)=>{signals.push(signal!);return{taskId:id,revision:1,promptText:'saved'};},command:vi.fn(()=>gate.promise)};
 const {result,rerender}=renderHook(({task,connected})=>usePreparation({task,connected,api,mutateTask}),{initialProps:{task,connected:true}});await waitFor(()=>expect(result.current.promptText).toBe('saved'));
 let sending!:Promise<boolean>;act(()=>{sending=result.current.send();});await act(async()=>{expect(await result.current.send()).toBe(false);gate.resolve({...task,revision:2});await sending;});expect(api.command).toHaveBeenCalledTimes(1);
 rerender({task:{...task,id:'22222222-2222-4222-8222-222222222222'},connected:false});expect(signals[0].aborted).toBe(true);
 await act(async()=>{expect(await result.current.send()).toBe(false);});
});
