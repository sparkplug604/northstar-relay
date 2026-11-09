import {z} from 'zod';
export const skillList=z.array(z.string().trim().min(1).max(60).transform(value=>value.toLowerCase())).max(30)
  .transform(values=>[...new Set(values)].sort());
export const jobSiteSchema=z.object({label:z.string().trim().min(1).max(200),latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)}).strict();
const time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const endTime=z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/);
const hours=z.object({weekday:z.number().int().min(1).max(7),start:time,end:endTime}).strict()
  .refine(row=>row.start<row.end,'End must be after start. Split overnight shifts at midnight.');
const off=z.object({start:z.string().datetime({offset:true}),end:z.string().datetime({offset:true})}).strict()
  .refine(row=>Date.parse(row.start)<Date.parse(row.end),'Time off must end after it starts');
export const technicianProfileSchema=z.object({
  timezone:z.string().max(80).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'Use an IANA timezone'),
  skills:skillList,workingHours:z.array(hours).max(28),timeOff:z.array(off).max(100),base:jobSiteSchema.nullable(),
}).strict();

export const serviceWindowSchema=z.object({
  earliestStart:z.string().datetime({offset:true}).nullable(),
  completeBy:z.string().datetime({offset:true}).nullable(),
}).strict().refine(value=>!value.earliestStart||!value.completeBy||Date.parse(value.earliestStart)<Date.parse(value.completeBy),'Completion must be after the earliest start');
