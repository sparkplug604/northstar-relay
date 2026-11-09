import {defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {approveBlocker,blockerWorkflowSchema} from '../server/recovery/blocker.js';
export default defineAction({description:'Dispatcher approval of the exact reviewed blocker update. Save one version-checked Relay change and verify the job-history receipt.',agentTool:false,mcpTool:false,schema:z.object({jobId:z.string().min(1).max(200),revision:z.number().int().positive()}),outputSchema:blockerWorkflowSchema,run:({jobId,revision})=>approveBlocker(jobId,revision)});
