import {AgentActionStopError,defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {jobActionOutput} from '../server/relay-native/job-action-output.js';
import {updateClientDeadline} from '../server/relay-native/client-deadline.js';
export default defineAction({
 description:'Update the client completion deadline, the date/time the client needs this job finished. Use this for a requested new client deadline. Supply local calendar date YYYY-MM-DD and local 24-hour time HH:mm; the server converts the branch timezone. Copy jobId and expectedVersion from the current record. Preserves the visit, technician, earliest start, priority, site, duration and skills. Requires Native approval and verifies the saved deadline. Do not use a work commitment or assignment tool to change a client deadline.',
 schema:z.object({jobId:z.string().min(1).max(200),expectedVersion:z.number().int().positive(),date:z.iso.date(),time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe('Local 24-hour time: 18:00 means 6 p.m.')}),outputSchema:jobActionOutput,
 needsApproval:true,allowPersistentApproval:false,retrySafe:true,deferLoading:false,chatUI:{renderer:'core.record-change'},mcpAnnotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:true},
 run:async input=>{const result=await updateClientDeadline(input);if(!result._receipt.verified)throw new AgentActionStopError(result._receipt.summary,{errorCode:'client_deadline_rejected',toolResult:JSON.stringify(result)});return result;},
});
