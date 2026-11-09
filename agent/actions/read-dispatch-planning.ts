import {defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {nextWorkPeriods} from '../server/recovery/staff.js';
import {relay} from '../server/recovery/relay.js';

export const technician=z.object({
  nextWorkPeriods:z.array(z.object({start:z.string(),end:z.string(),startLabel:z.string(),endLabel:z.string()})).optional(),
  personId:z.string(),displayName:z.string(),phone:z.string().nullable().optional(),email:z.string().nullable().optional(),branchId:z.string(),version:z.number(),
  profile:z.object({
    timezone:z.string(),skills:z.array(z.string()),
    workingHours:z.array(z.object({weekday:z.number(),start:z.string(),end:z.string()})),
    timeOff:z.array(z.object({start:z.string(),end:z.string()})),
    base:z.object({label:z.string(),latitude:z.number(),longitude:z.number()}).nullable(),
  }).nullable(),
});
export async function readTechnicians(){
 const [result,people]=await Promise.all([relay<{items:unknown[]}>('/technicians'),relay<{items:Array<{id:string;phone:string|null;email:string|null}>}>('/people')]);
 return result.items.map(person=>{const tech=technician.parse(person),contact=people.items.find(p=>p.id===tech.personId);return {...tech,phone:contact?.phone??null,email:contact?.email??null,nextWorkPeriods:nextWorkPeriods(tech.profile)};});
}

const matches=z.object({
  jobId:z.string(),jobVersion:z.number(),scheduledAt:z.string().nullable(),estimatedMinutes:z.number().nullable(),checkedAt:z.string(),
  candidates:z.array(z.object({
    personId:z.string(),displayName:z.string(),phone:z.string().nullable().optional(),email:z.string().nullable().optional(),profileVersion:z.number(),
    status:z.enum(['available','blocked','needs_check']),reasons:z.array(z.string()),
    travel:z.array(z.object({direction:z.enum(['before','after']),from:z.string(),to:z.string(),minutes:z.number().nullable(),source:z.string()})),
  })),
});
export default defineAction({
  description:'Read live Relay technician working hours, time off and skills. Include a jobId to check technician suitability, booked visits and estimated road travel for its scheduled time. Never treat missing data as availability.',
  schema:z.object({jobId:z.string().min(1).max(200).optional().describe('Relay job id from the live board. Omit to read technician profiles without a job-specific check.')}),
  outputSchema:z.object({technicians:z.array(technician),matches:matches.nullable()}),
  http:{method:'GET'},
  readOnly:true,
  run:async({jobId})=>{
    const people=await readTechnicians();
    const result=jobId?await relay<z.infer<typeof matches>>('/jobs/'+encodeURIComponent(jobId)+'/technicians'):null;
    return {technicians:people,matches:result};
  },
});
