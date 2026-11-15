// Generated from packages/operation-coordinator/src/background-requests.ts. Do not edit directly.
import { createHash } from 'node:crypto';
import type { StoreContext } from './sqlite.ts';
export interface BackgroundRequest {
  owner: string;
  key: string;
  digest: string;
  state: 'accepted' | 'dispatching' | 'returned';
  operations: Array<{ operationId: string; taskId: string; token: string }>;
  result?: unknown;
}
const prefix = 'background-request-v1:';
function storageKey(owner: string, key: string) { return prefix + createHash('sha256').update(JSON.stringify([owner, key])).digest('hex'); }
export class BackgroundRequests {
  constructor(private context: StoreContext, private alive: () => void) {}
  read(owner: string, key: string): BackgroundRequest | undefined {
    this.alive();
    const row = this.context.db.prepare('SELECT value FROM coordinator_state WHERE key=?').get(storageKey(owner,key));
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  private write(value: BackgroundRequest) {
    this.context.db.prepare('INSERT OR REPLACE INTO coordinator_state (key,value) VALUES (?,?)').run(storageKey(value.owner,value.key),JSON.stringify(value));
  }
  accept(owner: string, key: string, digest: string) {
    this.alive();
    return this.context.transaction(() => {
      const prior=this.read(owner,key);
      if(prior) { if(prior.digest!==digest) throw new Error('request-conflict: Background request key changed content'); return { prior:true, record:prior }; }
      const record:BackgroundRequest={owner,key,digest,state:'accepted',operations:[]}; this.write(record); return {prior:false,record};
    });
  }
  dispatch(owner:string,key:string) { this.update(owner,key,value=>{ if(value.state!=='accepted') throw new Error('Background request already dispatched'); value.state='dispatching'; }); }
  operation(owner:string,key:string, operation:BackgroundRequest['operations'][number]) { this.update(owner,key,value=>{
    if(value.state!=='dispatching') throw new Error('Background request is not dispatching');
    if(value.operations.some(prior=>prior.operationId===operation.operationId)) throw new Error('Background operation already prepared');
    value.operations.push(operation);
  }); }
  finish(owner:string,key:string,result:unknown) { this.update(owner,key,value=>{value.result=result;value.state='returned';}); }
  private update(owner:string,key:string,change:(value:BackgroundRequest)=>void) {
    this.alive(); this.context.transaction(()=>{const value=this.read(owner,key); if(!value) throw new Error('Background request not admitted'); change(value);this.write(value);});
  }
  pending():BackgroundRequest[] { this.alive(); return this.context.db.prepare("SELECT value FROM coordinator_state WHERE key LIKE 'background-request-v1:%'").all().map(row=>JSON.parse(String(row.value))).filter(value=>value.state!=='returned'); }
}
