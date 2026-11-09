import {defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {assignmentJob,assertAssignmentContext,readAssignment,assignmentSchema} from '../server/recovery/assignment.js';

export default defineAction({
  description:'Find technician openings for the current assignment job within its client service window. Supports later start preferences and excluding technicians. Read before proposing an alternative.',
  schema:z.object({
    jobId:z.string().min(1).max(200).optional().describe('Optional Relay job id. Omit to use the current assignment job.'),
    notBefore:z.iso.datetime({offset:true}).optional().describe('Optional earliest start preference in ISO 8601. Must remain within the client window.'),
    excludePersonIds:z.array(z.string().min(1).max(200)).max(20).optional().describe('Optional technician ids to exclude when the dispatcher asks for alternatives.'),
  }),
  outputSchema:assignmentSchema,
  deferLoading:true,
  http:{method:'GET'},readOnly:true,
  run:async({jobId,notBefore,excludePersonIds})=>{
    const current=jobId??await assignmentJob();
    if(!current)throw Error('Open Assign someone on a job first.');
    await assertAssignmentContext(current);
    return readAssignment(current,notBefore,excludePersonIds);
  },
});
