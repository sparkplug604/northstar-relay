import {defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {readTriage,triageSchema} from '../server/recovery/triage.js';
export default defineAction({
 description:'Read live Relay priority jobs, their client deadlines, blockers and assignment gaps, plus technician profiles. This does not assign anyone or verify an available time.',
 schema:z.object({jobId:z.string().min(1).max(200).optional()}),outputSchema:triageSchema,
 http:{method:'GET'},readOnly:true,deferLoading:false,
 run:({jobId})=>readTriage(jobId),
});
