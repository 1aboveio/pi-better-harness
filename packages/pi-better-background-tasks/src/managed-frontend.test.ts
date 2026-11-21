import { describe, it, expect, vi, beforeEach } from 'vitest';
const fixture = vi.hoisted(() => ({ request: vi.fn(), enqueue: vi.fn(), urgent: vi.fn(), observe: undefined as undefined | (() => void) }));
vi.mock('./managed-client.js', () => ({ requestBackgroundTool: fixture.request }));
vi.mock('./work-observation.js', () => ({ onBackgroundObservation: (_pi: unknown, callback: () => void) => { fixture.observe = callback; return () => { }; } }));
vi.mock('./shared-callback-batcher.js', () => ({ getCallbackBatcher: () => ({ enqueue: fixture.enqueue,deliverUrgent:fixture.urgent }) }));
import { createManagedBackgroundFrontend } from './managed-frontend.js';
import { createBackgroundTasksNavigator } from './navigator-provider.js';
import { NAVIGATOR_PANEL_WIDGET_KEY, setNavigatorPanel } from './shared-navigator-panels.ts';
const context = (branch: any[] = []) => ({ cwd: '/workspace', sessionManager: { getSessionId: () => 'native', getBranch: () => branch } } as any);
beforeEach(() => { fixture.request.mockReset(); fixture.enqueue.mockReset();fixture.urgent.mockReset(); fixture.observe = undefined; });
describe('managed native UI boundary', () => {
    it('keeps running tasks beside the todo when an older server includes a pending callback pointer', async () => {
      const pi = { registerTool() {} } as any;
      const frontend = createManagedBackgroundFrontend(pi);
      const navigator = createBackgroundTasksNavigator(undefined, frontend.ui);
      let widget: { render(width: number): string[] } | undefined;
      const theme = { fg: (_color: string, text: string) => text };
      const ctx = { ...context(), mode: 'tui', hasUI: true, ui: {
        theme, setEditorComponent() {},
        setWidget(key: string, factory: any) {
          if (key === NAVIGATOR_PANEL_WIDGET_KEY) widget = factory?.({ requestRender() {} }, theme);
        },
      } };
      const running = (name: string, kind: string) => ({
        durable: true, id: kind, name, kind, status: 'running', active: true, terminal: false,
        startedAt: Date.now(), waits: [], cwd: ctx.cwd, exitCode: null,
      });
      const pointer = { durable: true, id: 'old-failure', operationId: 'old-op', status: 'failed',
        terminal: true, active: false, endedAt: Date.now() - 60000, callbackPending: true };
      fixture.request.mockResolvedValue({
        tasks: [pointer, running('PostgreSQL check', 'process'), running('Android CI watch', 'watch')],
        deliveries: [{ token: 'lease', receiptId: 'receipt', notification: {
          taskId: pointer.id, origin: { cwd: ctx.cwd, sessionId: 'native' }, status: 'failed', event: {},
        } }],
      });
      try {
        frontend.host.start(ctx, false);
        navigator.ensureBackgroundTasksNavigatorProvider(pi);
        navigator.ensureBackgroundTasksNavigator(ctx);
        setNavigatorPanel(ctx, 'pi-better-plan', () => ({ render: () => ['todo 1/4 complete'], invalidate() {} }));
        await frontend.host.reconcileNow();
        const screen = widget?.render(120).join('\n');
        expect(screen).toContain('todo 1/4 complete');
        expect(screen).toContain('PostgreSQL check');
        expect(screen).toContain('Android CI watch');
        expect(frontend.host.readDurableTask({ cwd: ctx.cwd, sessionId: 'native' }, pointer.id)).toBeUndefined();
        expect(fixture.enqueue).toHaveBeenCalledOnce();
      } finally {
        setNavigatorPanel(ctx, 'pi-better-plan', undefined);
        navigator.clearBackgroundTasksNavigatorSession();
        frontend.host.close();
      }
    });
    it('opens observation once on demand and discards a pending poll after a session switch', async () => {
      let release!: (snapshot: unknown) => void;
      const poll = new Promise(resolve => { release = resolve; });
      fixture.request.mockReturnValue(poll);
      const frontend = createManagedBackgroundFrontend({ registerTool() {} } as any);
      frontend.host.start(context(), false);
      expect(frontend.ui.rows()).toEqual([]);
      expect(fixture.request).not.toHaveBeenCalled();
      frontend.ui.onOpen?.();
      frontend.ui.onOpen?.();
      expect(fixture.request).toHaveBeenCalledTimes(1);
      frontend.host.close();
      frontend.host.start(context(), false);
      release({ tasks: [], legacyRows: [{ id: 'old' }], deliveries: [] });
      await poll;
      expect(frontend.ui.rows()).toEqual([]);
      expect(fixture.enqueue).not.toHaveBeenCalled();
      frontend.host.close();
    });
    it('passes late terminal observations to the navigator and keeps rows through rebuilding and request failure', async () => {
      const origin = {cwd:'/workspace',sessionId:'native'};
      const terminal = {id:'finished',terminal:true,endedAt:Date.now()-60000};
      fixture.request.mockResolvedValue({tasks:[terminal],legacyRows:[{id:'legacy',status:'failed',expiresAt:1}],deliveries:[]});
      const frontend=createManagedBackgroundFrontend({registerTool(){}} as any);
      frontend.host.start(context());await frontend.host.reconcileNow();
      expect(frontend.host.listDurableTasks(origin,{retentionMs:30000})).toEqual([terminal]);
      expect(frontend.ui.rows()).toHaveLength(1);
      fixture.request.mockResolvedValue({status:'rebuilding',tasks:[],legacyRows:[]});
      await frontend.host.reconcileNow();expect(frontend.ui.rows()).toHaveLength(1);
      fixture.request.mockRejectedValue(new Error('disconnected'));
      await expect(frontend.host.reconcileNow()).rejects.toThrow('disconnected');
      expect(frontend.host.listDurableTasks(origin)).toEqual([terminal]);
      frontend.host.close();expect(frontend.ui.rows()).toHaveLength(0);
    });
    it('shows worker-owned tasks without adopting their stop authority', async () => {
      const origin={cwd:'/workspace',sessionId:'native'};
      fixture.request.mockResolvedValue({tasks:[{id:'child',active:true,readOnly:true,parentAgentId:'worker'}],legacyRows:[],deliveries:[]});
      const frontend=createManagedBackgroundFrontend({registerTool(){}} as any);
      frontend.host.start(context()); await frontend.host.reconcileNow();
      expect(frontend.host.listDurableTasks(origin)[0].parentAgentId).toBe('worker');
      expect(frontend.host.ownsDurableTask('child')).toBe(false);
      fixture.request.mockClear();
      expect(frontend.ui.close('child').action).toBe('not-closable');
      expect(fixture.request).not.toHaveBeenCalled();
      frontend.host.close();
    });
    it('captures poll, queue, handoff, receipt and failure without changing delivery', async () => {
      vi.stubEnv('PI_BG_OBSERVED_WAITS_DEBUG', '1');
      const output = vi.spyOn(console, 'error').mockImplementation(() => {});
      let delivered = false;
      fixture.request.mockImplementation(async (_pi, _ctx, _key, tool) => {
        if (tool === '__background_receipt') { delivered = true; return {}; }
        return { tasks: [], deliveries: delivered ? [] : [{ token: 'private-token', receiptId: 'receipt',
          notification: { taskId: 'watch', origin: { cwd: '/workspace', sessionId: 'native' }, status: 'succeeded', event: {} } }] };
      });
      const frontend = createManagedBackgroundFrontend({ registerTool() {} } as any);
      try {
        frontend.host.start(context()); await frontend.host.reconcileNow();
        expect(fixture.enqueue).toHaveBeenCalledTimes(1);
        fixture.enqueue.mock.calls[0][0].onDelivered();
        await vi.waitFor(() => expect(delivered).toBe(true));
        await frontend.host.reconcileNow();
        const records = () => output.mock.calls.filter(call => call[0] === '[background-handoff-frontend]').map(call => JSON.parse(call[1]));
        expect(records().map(item => item.stage)).toEqual(expect.arrayContaining(['poll-start', 'poll-received', 'queue', 'handoff', 'receipt-return']));
        expect(JSON.stringify(records())).not.toContain('private-token');
        fixture.request.mockRejectedValue(new Error('actual poll refusal'));
        await expect(frontend.host.reconcileNow()).rejects.toThrow('actual poll refusal');
        expect(records().some(item => item.stage === 'poll-error' && item.error.includes('actual poll refusal'))).toBe(true);
        for (let i = 0; i < 140; i++) {
          fixture.request.mockRejectedValue(new Error(`distinct failure ${i}`));
          await frontend.host.reconcileNow().catch(() => {});
        }
        expect(records().length).toBeLessThanOrEqual(128);
        expect(records().at(-1).stage).toBe('capture-limit');
        expect(output.mock.calls.every(call => String(call[1]).length <= 4096)).toBe(true);
      } finally { frontend.host.close(); output.mockRestore(); vi.unstubAllEnvs(); }
    });
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
    it('uses only bounded exact-owner structured proofs while shared observations lag', async () => {
      let registered: any;
      fixture.request.mockImplementation(async (_pi, _ctx, _key, tool, params) => tool === '__background_poll'
        ? { tasks: [], legacyRows: [], deliveries: [] }
        : { content: [{ type: 'text', text: 'arbitrary caller-looking task id' }], details: { backgroundOwnership: {
          id: params.id, operationId: `operation-${params.id}`, owner: { kind: 'parent-session', workspace: '/workspace', sessionId: params.foreign ? 'foreign' : 'native' },
        } } });
      const frontend = createManagedBackgroundFrontend({ registerTool(tool: any) { registered = tool; } } as any), ctx = context();
      frontend.host.start(ctx);
      frontend.proxy.registerTool({ name: 'bg_task_status', parameters: {}, execute() {} } as any);
      await registered.execute('status', { id: 'owned' }, undefined, undefined, ctx);
      expect(frontend.host.ownsDurableTask('owned')).toBe(true);
      frontend.host.noteParentContext(context([{ id: 'policy-change' }]));
      expect(frontend.host.ownsDurableTask('owned')).toBe(true);
      await registered.execute('foreign', { id: 'foreign', foreign: true }, undefined, undefined, ctx);
      expect(frontend.host.ownsDurableTask('foreign')).toBe(false);
      for (let index = 0; index < 257; index++) await registered.execute(`status-${index}`, { id: `owned-${index}` }, undefined, undefined, ctx);
      expect(frontend.host.ownsDurableTask('owned-0')).toBe(false);
      expect(frontend.host.ownsDurableTask('owned-256')).toBe(true);
      frontend.host.noteParentContext({ ...ctx, sessionManager: { getSessionId: () => 'replacement', getBranch: () => [] } } as any);
      expect(frontend.host.ownsDurableTask('owned-256')).toBe(false);
      frontend.host.close();
    });
    it('fences a reused native session manager whose session ID changes in place', async () => {
      let sessionId = 'native', registered: any;
      const ctx = { cwd: '/workspace', sessionManager: { getSessionId: () => sessionId, getBranch: () => [] } } as any;
      fixture.request.mockImplementation(async (_pi, _ctx, _key, tool) => tool === '__background_poll' ? { tasks: [], deliveries: [] }
        : { details: { backgroundOwnership: { id: 'old', operationId: 'op-old', owner: { kind: 'parent-session', workspace: '/workspace', sessionId: 'native' } } } });
      const frontend = createManagedBackgroundFrontend({ registerTool(tool: any) { registered = tool; } } as any);
      frontend.host.start(ctx); frontend.proxy.registerTool({ name: 'bg_task_status', parameters: {}, execute() {} } as any);
      await registered.execute('old', {}, undefined, undefined, ctx);
      expect(frontend.host.ownsDurableTask('old')).toBe(true);
      sessionId = 'replacement';
      expect(frontend.host.ownsDurableTask('old')).toBe(false);
      frontend.host.noteParentContext(ctx);
      sessionId = 'native'; frontend.host.noteParentContext(ctx);
      expect(frontend.host.ownsDurableTask('old')).toBe(false);
      frontend.host.close();
    });
    it.each(['close', 'switch'])('does not restore old ownership from a late tool result after %s', async (change) => {
      let release!: (value: any) => void, registered: any;
      fixture.request.mockImplementation(async (_pi, _ctx, _key, tool) => tool === '__background_poll'
        ? { tasks: [], legacyRows: [], deliveries: [] } : new Promise(resolve => { release = resolve; }));
      const frontend = createManagedBackgroundFrontend({ registerTool(tool: any) { registered = tool; } } as any), ctx = context();
      frontend.host.start(ctx);
      frontend.proxy.registerTool({ name: 'bg_task_spawn', parameters: {}, execute() {} } as any);
      const pending = registered.execute('late', {}, undefined, undefined, ctx);
      if (change === 'close') frontend.host.close();
      else frontend.host.noteParentContext({ ...ctx, sessionManager: { getSessionId: () => 'new-owner', getBranch: () => [] } } as any);
      release({ details: { backgroundOwnership: { id: 'old', operationId: 'op-old', owner: { kind: 'parent-session', workspace: '/workspace', sessionId: 'native' } } } });
      await pending;
      expect(frontend.host.ownsDurableTask('old')).toBe(false);
      frontend.host.close();
    });
    it.each(['tool', 'stop'])('awaits the required follow-up observation before %s resolves', async (kind) => {
      let releaseOld!: (value: any) => void, releaseFresh!: (value: any) => void;
      let polls = 0, registered: any;
      fixture.request.mockImplementation(async (_pi, _ctx, _key, tool) => {
        if (tool !== '__background_poll') return { content: [{ type: 'text', text: 'accepted' }] };
        polls++;
        return new Promise(resolve => { if (polls === 1) releaseOld = resolve; else releaseFresh = resolve; });
      });
      const frontend = createManagedBackgroundFrontend({ registerTool(tool: any) { registered = tool; } } as any);
      const ctx = context(); frontend.host.start(ctx);
      frontend.proxy.registerTool({ name: 'bg_task_spawn', parameters: {}, execute() {} } as any);
      let resolved = false;
      const completed = (kind === 'tool' ? registered.execute('call', {}, undefined, undefined, ctx)
        : frontend.host.stopDurableTask({ cwd: '/workspace', sessionId: 'native' }, 'durable')).then(() => { resolved = true; });
      await Promise.resolve(); await Promise.resolve();
      releaseOld({ tasks: [], legacyRows: [], deliveries: [] });
      await vi.waitFor(() => expect(polls).toBe(2));
      expect(resolved).toBe(false);
      releaseFresh({ tasks: [{ id: 'durable', active: true }], legacyRows: [], deliveries: [] });
      await completed;
      expect(frontend.host.ownsDurableTask('durable')).toBe(true);
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
