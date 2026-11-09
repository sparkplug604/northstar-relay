import {defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {assertAssignmentContext,assignmentSchema} from '../server/recovery/assignment.js';
import {relay} from '../server/recovery/relay.js';

export default defineAction({
  description:'Save a shared technician-and-time proposal for the current job after the dispatcher asks for a recommendation or alternative. This changes the proposal only. The dispatcher must approve the actual assignment.',
  schema:z.object({
    jobId:z.string().min(1).max(200).describe('Current Relay job id.'),
    revision:z.number().int().nonnegative().describe('Exact current shared proposal revision.'),
    jobVersion:z.number().int().positive().describe('Exact current Relay job version.'),
    personId:z.string().min(1).max(200).describe('Exact technician id from an available opening.'),
    scheduledAt:z.iso.datetime({offset:true}).describe('Exact available start timestamp from read-assignment-options.'),
    reason:z.string().max(500).optional().transform(value=>value?.trim()||'Matches the client window, skills, working hours and travel checks.').describe('Optional short explanation. If omitted or empty, defaults to a summary of the verified checks.'),
  }),
  outputSchema:assignmentSchema,
  agentTool:false,mcpTool:false,
  mcpAnnotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  run:async({jobId,...body})=>{
    await assertAssignmentContext(jobId);
    return assignmentSchema.parse(await relay('/jobs/'+encodeURIComponent(jobId)+'/assignment/proposal',{body,key:randomUUID()}));
  },
});
