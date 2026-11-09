import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({context:{} as any,navigation:{jobId:'other-tab-job'} as any,reads:0}));
vi.mock('@agent-native/core/server/request-context',()=>({getRequestRunContext:()=>state.context}));
vi.mock('@agent-native/core/application-state',()=>({readAppStateForCurrentTab:async()=>{state.reads++;return state.navigation;}}));
import {selectedRelayJobId} from './selected-job.js';
beforeEach(()=>{state.context={};state.navigation={jobId:'other-tab-job'};state.reads=0;});
it('honours an explicit requested job over a different selected job',async()=>{
 state.context={actionScope:{jobId:'parkside'}};expect(await selectedRelayJobId('cedar')).toBe('cedar');expect(state.reads).toBe(0);
});
it('uses the validated action scope when Qwen omits the selected job id',async()=>{
 state.context={actionScope:{jobId:'parkside'},browserTabId:'tab-1'};expect(await selectedRelayJobId()).toBe('parkside');expect(state.reads).toBe(0);
});
it('falls back to the current browser tab selection without scope',async()=>{
 state.context={browserTabId:'tab-1'};state.navigation={jobId:'oak'};expect(await selectedRelayJobId()).toBe('oak');expect(state.reads).toBe(1);
});
it('never falls back to another tab or a globally last-opened job',async()=>{
 await expect(selectedRelayJobId()).rejects.toThrow('No job is selected');expect(state.reads).toBe(0);
 state.context={browserTabId:'tab-1'};state.navigation={view:'home'};await expect(selectedRelayJobId()).rejects.toThrow('No job is selected');
});
