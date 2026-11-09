import {defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {readDispatchJobs,dispatchJobsSchema} from '../server/recovery/dispatch-job.js';
export default defineAction({
 description:'Read current job facts with resolved technician names, scheduled visit, work order acceptance, commitments, recent history, and optionally checked technician openings. Read only; does not propose or apply changes.',
 schema:z.object({jobIds:z.array(z.string().min(1).max(200)).min(1).max(3),includeAvailability:z.boolean().default(false)}),
 outputSchema:dispatchJobsSchema,http:{method:'GET'},readOnly:true,deferLoading:true,
 run:({jobIds,includeAvailability})=>readDispatchJobs(jobIds,includeAvailability),
});
