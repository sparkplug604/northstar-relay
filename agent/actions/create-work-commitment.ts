import {defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {runJobChange} from '../server/relay-native/job-actions.js';
import {jobActionOutput} from '../server/relay-native/job-action-output.js';
export default defineAction({
 description:'Create a real work commitment after approval. FIRST call read-relay-job-context with includePlanning=true. Copy jobId, expectedVersion, ownerId and dueAt from its nextShiftCommitmentDefaults when requested during the assigned technician’s next shift. Set title to the requested task. Never use a jobId as ownerId or invent a time. Returns a verified Relay history receipt.',
 schema:z.object({jobId:z.string().min(1).max(200),expectedVersion:z.number().int().positive(),title:z.string().trim().min(3).max(200).describe('The work the owner must do, preserving the requested object. For Riley to check with the client, use Check with client, not Check with Riley.'),ownerId:z.string().min(1).max(200),dueAt:z.iso.datetime({offset:true})}),
 outputSchema:jobActionOutput,needsApproval:true,allowPersistentApproval:false,retrySafe:true,deferLoading:false,
 mcpAnnotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false,idempotentHint:true},chatUI:{renderer:'core.record-change'},
 run:async({jobId,expectedVersion,title,ownerId,dueAt})=>runJobChange({jobId,expectedVersion,change:{action:'add_milestone',title,ownerId,dueAt}}),
});
