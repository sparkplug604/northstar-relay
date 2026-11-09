import {defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {readBlockerWorkflow,blockerWorkflowSchema} from '../server/recovery/blocker.js';
export default defineAction({description:'Read the current job blocker, shared review draft, and verified job-history receipt.',schema:z.object({jobId:z.string().min(1).max(200)}),outputSchema:blockerWorkflowSchema,http:{method:'GET'},readOnly:true,deferLoading:false,run:({jobId})=>readBlockerWorkflow(jobId)});
