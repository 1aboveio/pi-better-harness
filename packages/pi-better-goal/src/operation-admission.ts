import type {ExtensionContext} from '@earendil-works/pi-coding-agent';

export const OPERATION_RESUME_ADMISSION='pi-better-goal:operation-resume-admission';
export interface OperationResumeOwner {sessionId:string;workspace:string;branchId?:string|null;goalId?:string|null}
export interface OperationResumeGate {allowed:boolean;reason?:string;revision:number;isCurrent?:()=>boolean}
export interface OperationResumeRequest {version:1;owner:OperationResumeOwner;reply:(gate:OperationResumeGate)=>void}

/** A recorded branch anchor remains valid on descendants, not on an abandoned fork. */
export function operationOwnerMatches(ctx:ExtensionContext|undefined,owner:OperationResumeOwner):boolean {
 if(!ctx||ctx.cwd!==owner.workspace)return false;
 try{
  if(ctx.sessionManager.getSessionId()!==owner.sessionId)return false;
  if(owner.branchId&&!ctx.sessionManager.getBranch().some(entry=>entry.id===owner.branchId))return false;
  return true;
 }catch{return false;}
}
