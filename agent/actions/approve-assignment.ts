import {defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {relay} from '../server/recovery/relay.js';
import {assertAssignmentContext} from '../server/recovery/assignment.js';

export default defineAction({
  description:'Dispatcher approval of the reviewed assignment proposal. Atomically save the technician and visit time after rechecking availability and the client deadline.',
  agentTool:false,mcpTool:false,
  schema:z.object({jobId:z.string().min(1).max(200).describe('Reviewed Relay job id.'),revision:z.number().int().nonnegative().describe('Exact reviewed proposal revision.')}),
  outputSchema:z.object({job:z.object({id:z.string(),version:z.number(),assigneeId:z.string().nullable(),scheduledAt:z.string().nullable()}).passthrough()}).passthrough(),
  run:async({jobId,revision})=>{
    await assertAssignmentContext(jobId);
    return relay('/jobs/'+encodeURIComponent(jobId)+'/assignment/approve',{body:{revision},key:randomUUID()});
  },
});
