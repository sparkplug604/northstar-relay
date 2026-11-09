import {defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {runJobChange} from '../server/relay-native/job-actions.js';
import {jobActionOutput} from '../server/relay-native/job-action-output.js';
export default defineAction({
 description:'Save a job update after dispatcher approval. Never use this to perform a requested date, assignment or status change; use the corresponding action. A note saying date changed does not change the date. Call this when asked to record a client-confirmed appointment or another supplied update. Copy jobId and expectedVersion from current-screen.record.job. Put the supplied facts in note. This only adds a history note; it does not change the appointment, technician or status. Never say an update was recorded without calling this action and receiving its verified receipt.',
 schema:z.object({jobId:z.string().min(1).max(200),expectedVersion:z.number().int().positive(),note:z.string().trim().min(3).max(10000).describe('The supplied update or client confirmation. Do not invent contact or confirmation.')}),
 outputSchema:jobActionOutput,needsApproval:true,allowPersistentApproval:false,retrySafe:true,deferLoading:false,
 mcpAnnotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:true},chatUI:{renderer:'core.record-change'},
 run:({jobId,expectedVersion,note})=>runJobChange({jobId,expectedVersion,change:{action:'add_update',note}}),
});
