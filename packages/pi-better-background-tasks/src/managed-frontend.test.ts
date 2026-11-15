import { describe, it, expect, vi, beforeEach } from 'vitest';
const fixture = vi.hoisted(() => ({ request: vi.fn(), enqueue: vi.fn(), urgent: vi.fn(), observe: undefined as undefined | (() => void) }));
vi.mock('./managed-client.js', () => ({ requestBackgroundTool: fixture.request }));
vi.mock('./work-observation.js', () => ({ onBackgroundObservation: (_pi: unknown, callback: () => void) => { fixture.observe = callback; return () => { }; } }));
vi.mock('./shared-callback-batcher.js', () => ({ getCallbackBatcher: () => ({ enqueue: fixture.enqueue,deliverUrgent:fixture.urgent }) }));
import { createManagedBackgroundFrontend } from './managed-frontend.js';
const context = (branch: any[] = []) => ({ cwd: '/workspace', sessionManager: { getSessionId: () => 'native', getBranch: () => branch } } as any);
beforeEach(() => { fixture.request.mockReset(); fixture.enqueue.mockReset();fixture.urgent.mockReset(); fixture.observe = undefined; });
describe('managed native UI boundary', () => {
    it('keeps 60 render reads free of provider requests and fetches evidence only on explicit selection', async () => {
        fixture.request.mockImplementation(async (_pi, _ctx, _key, tool) => tool === '__background_poll' ? { tasks: [{ id: 'durable', active: true }], legacyRows: [{ id: 'legacy', status: 'running' }], deliveries: [] } : tool === '__background_log' ? { stdout: 'evidence' } : { id: 'legacy' });
        const frontend = createManagedBackgroundFrontend({ registerTool() { } } as any), ctx = context();
        frontend.host.start(ctx);
        await vi.waitFor(() => expect(frontend.host.listDurableTasks({ cwd: '/workspace', sessionId: 'native' })).toHaveLength(1));
        fixture.request.mockClear();
        for (let i = 0; i < 60; i++) {
            frontend.ui.rows();
            frontend.ui.detail('legacy', Date.now());
            frontend.host.readDurableTaskLog({ cwd: '/workspace', sessionId: 'native' }, 'durable');
        }
        expect(fixture.request).not.toHaveBeenCalled();
        frontend.ui.prepareDetail('durable');
        frontend.ui.prepareDetail('legacy');
        await vi.waitFor(() => expect(frontend.ui.detail('legacy', Date.now())).toEqual({ id: 'legacy' }));
        expect(fixture.request).toHaveBeenCalledTimes(2);
        fixture.request.mockClear();
        for (let i = 0; i < 60; i++) {
            frontend.ui.rows();
            frontend.ui.detail('legacy', Date.now());
            expect(frontend.host.readDurableTaskLog({ cwd: '/workspace', sessionId: 'native' }, 'durable')).toEqual({ stdout: 'evidence' });
        }
        expect(fixture.request).not.toHaveBeenCalled();
        frontend.host.close();
    });
    it.each([false,true])('acknowledges exact native structured transcript proof without appending again (urgent=%s)', async (urgent) => {
        let acknowledged=false;
        fixture.request.mockImplementation(async (_pi, _ctx, _key, tool) => tool === '__background_poll' ? { tasks: [], legacyRows: [], deliveries: acknowledged?[]:[{ token: 'new-lease', receiptId: 'receipt', notification: {urgent,event:{customType:'background-task-failure'}, taskId: 'task', origin: { cwd: '/workspace', sessionId: 'native' }, status: 'succeeded' } }] } : (acknowledged=true,{ receipted: true }));
        const frontend = createManagedBackgroundFrontend({ registerTool() { } } as any);
        frontend.host.start(context([{ id: 'message', type: 'custom_message', customType: urgent?'background-task-failure':'background-completion-batch', details: urgent?{urgentEventId:'receipt'}:{ completionEventIds: ['receipt'] } }]));
        await vi.waitFor(() => expect(fixture.request.mock.calls.some(call => call[3] === '__background_receipt' && call[4].delivered === true)).toBe(true));
        expect(fixture.enqueue).not.toHaveBeenCalled();expect(fixture.urgent).not.toHaveBeenCalled();
        frontend.host.close();
    });
    it('restarts a delayed observation after session switch and discards old detail responses',async()=>{
      let releaseFirst!:(value:any)=>void,releaseDetail!:(value:any)=>void;let polls=0;
      fixture.request.mockImplementation(async(_pi,_ctx,_key,tool)=>{
        if(tool==='__background_detail')return new Promise(resolve=>releaseDetail=resolve);
        if(++polls===1)return new Promise(resolve=>releaseFirst=resolve);
        return {tasks:[],legacyRows:[{id:'new',status:'running'}],deliveries:[]};
      });
      const frontend=createManagedBackgroundFrontend({registerTool(){}} as any);
      frontend.host.start(context());frontend.ui.prepareDetail('old');frontend.host.close();frontend.host.start(context([{id:'new-branch'}]));
      let settled=false;const ready=frontend.host.reconcileNow().then(()=>{settled=true;});
      await Promise.resolve();expect(settled).toBe(false);
      releaseFirst({tasks:[],legacyRows:[{id:'old'}],deliveries:[]});releaseDetail({id:'old'});
      await ready;expect(frontend.ui.rows()[0]?.id).toBe('new');
      await vi.waitFor(()=>expect(frontend.ui.rows()[0]?.id).toBe('new'));
      expect(polls).toBe(2);expect(frontend.ui.detail('old',Date.now())).toBeNull();frontend.host.close();
    });

});
