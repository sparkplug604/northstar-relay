import {defineAction} from '@agent-native/core/action';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {assignmentJob,assignmentTurn,readAssignment,assignmentSchema} from '../server/recovery/assignment.js';
import {relay} from '../server/recovery/relay.js';

export default defineAction({
  description:'Save a checked proposal for the current assignment job. Choose earliest for a recommendation, alternative for another technician or time, or later for a later start. Actual assignment still needs dispatcher approval.',
  schema:z.object({
    jobId:z.string().min(1).max(200).optional().describe('Relay job id. Omit only when Assign someone is the current view.'),
    preference:z.enum(['earliest','alternative','later']).default('earliest').describe('earliest recommends the first opening; alternative asks for a different person or time; later asks for a later start. Defaults to earliest.'),
    technician:z.string().max(200).optional().describe('Optional technician name requested by the dispatcher, such as Casey or Sam. Omit to compare all technicians.'),
    notBefore:z.iso.datetime({offset:true}).optional().describe('Optional earliest start preference for a different day.'),
  }),
  outputSchema:assignmentSchema,
  deferLoading:true,
  mcpAnnotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  run:async({preference,technician,notBefore,jobId:requestedJobId})=>{
    const jobId=requestedJobId??await assignmentJob();
    if(!jobId)throw Error('Open Assign someone on the job first.');
    const state=await readAssignment(jobId,notBefore);
    const revision=state.revision;
    let options=state.options;
    if(technician){
      options=options.filter(option=>option.displayName.toLowerCase().includes(technician.toLowerCase()));
      if(new Set(options.map(option=>option.personId)).size>1)throw Error('More than one technician matches that name. Use the full name.');
    }
    if(preference==='later'&&state.proposal)options=options.filter(option=>Date.parse(option.scheduledAt)>Date.parse(state.proposal!.scheduledAt));
    if(preference==='alternative'&&state.proposal){
      const different=options.filter(option=>option.personId!==state.proposal!.personId);
      if(different.length)options=different;
    }
    const choice=options[0];
    if(!choice){
      const person=technician?state.unavailable.find(person=>person.displayName.toLowerCase().includes(technician.toLowerCase())):null;
      throw Error(person?person.displayName+': '+person.reasons.join(' '):'No checked opening fits that preference within the client window. Review the recorded constraints.');
    }
    const reason=preference==='earliest'?'Earliest checked opening that meets the client window, skills and availability.':
      preference==='later'?'A later checked opening within the client window.':'An alternative checked opening within the client window.';
    return assignmentSchema.parse(await relay('/jobs/'+encodeURIComponent(jobId)+'/assignment/proposal',{
      key:randomUUID(),body:{revision,jobVersion:state.job.version,personId:choice.personId,scheduledAt:choice.scheduledAt,reason},
    }));
  },
});
