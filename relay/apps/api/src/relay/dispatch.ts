import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {assignmentOptions,proposeAssignment,applyAssignment,getTechnicianMatches,listTechnicians,saveTechnician,type JobScope,type RelayPostgresStore} from '../../../../packages/relay-storage-postgres/src/index.js';
import {relayIdempotencyKey} from './app.js';
import type {RelayAuth} from './auth.js';

import {technicianProfileSchema} from './dispatchSchema.js';
function scope(auth:RelayAuth):JobScope{return {tenantId:auth.organization.id,actorId:auth.user.id,role:auth.user.role,branchId:auth.user.branchId};}
export function registerDispatchRoutes(app:FastifyInstance,store:RelayPostgresStore){
  const roles=['organization_admin','branch_dispatcher'] as const;
  app.get('/api/relay/v1/technicians',async request=>{
    const auth=await app.relayAuthorize(request,{roles});
    return listTechnicians(store,scope(auth));
  });
  app.post('/api/relay/v1/technicians/:id/planning',async request=>{
    const auth=await app.relayAuthorize(request,{roles});app.relayCsrf(request,auth);
    const id=z.string().min(1).max(200).parse((request.params as {id:unknown}).id);
    const input=z.object({expectedVersion:z.number().int().min(0),profile:technicianProfileSchema}).strict().parse(request.body);
    return saveTechnician(store,scope(auth),id,input,relayIdempotencyKey(request));
  });
  app.get('/api/relay/v1/jobs/:id/assignment',async request=>{
    const auth=await app.relayAuthorize(request,{roles});
    const id=z.string().min(1).max(200).parse((request.params as {id:unknown}).id);
    const query=z.object({notBefore:z.string().datetime({offset:true}).optional(),excludePersonIds:z.string().max(2000).optional()}).strict().parse(request.query);
    return assignmentOptions(store,scope(auth),id,{notBefore:query.notBefore,excludePersonIds:query.excludePersonIds?.split(',')});
  });
  app.post('/api/relay/v1/jobs/:id/assignment/proposal',async request=>{
    const auth=await app.relayAuthorize(request,{roles});app.relayCsrf(request,auth);
    const id=z.string().min(1).max(200).parse((request.params as {id:unknown}).id);
    const input=z.object({revision:z.number().int().nonnegative(),jobVersion:z.number().int().positive(),personId:z.string().min(1).max(200),
      scheduledAt:z.string().datetime({offset:true}),reason:z.string().trim().min(3).max(500)}).strict().parse(request.body);
    return proposeAssignment(store,scope(auth),id,input);
  });
  app.post('/api/relay/v1/jobs/:id/assignment/approve',async request=>{
    const auth=await app.relayAuthorize(request,{roles});app.relayCsrf(request,auth);
    const id=z.string().min(1).max(200).parse((request.params as {id:unknown}).id);
    const input=z.object({revision:z.number().int().nonnegative()}).strict().parse(request.body);
    return applyAssignment(store,scope(auth),id,input.revision);
  });
  app.get('/api/relay/v1/jobs/:id/technicians',async request=>{
    const auth=await app.relayAuthorize(request,{roles});
    const id=z.string().min(1).max(200).parse((request.params as {id:unknown}).id);
    return getTechnicianMatches(store,scope(auth),id);
  });
}
