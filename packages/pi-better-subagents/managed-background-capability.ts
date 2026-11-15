/** Native frontend advertises a server route, never a fake local mechanical service. */
export function nativeBackgroundCapability(pi: {events?: {emit(channel:string,value:unknown):void}}):boolean {
 let available=false;
 pi.events?.emit('pi-better-background-tasks:managed-capability',{accept(value:unknown){
   const capability=value as {version?:number;assignmentContinuation?:number}|undefined;
   available=capability?.version===1&&capability.assignmentContinuation===1;
 }});
 return available;
}
