import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

export type Draft = {
  pins: string[];
  proposal: { externalId: string; scheduledAt: string; reason: string; jobId?: string; jobVersion: number; key: string } | null;
};
export const drafts = pgTable("relay_recovery_drafts", {
  id: text().primaryKey(),
  revision: integer().notNull(),
  fields: jsonb().$type<Draft>().notNull(),
});

export type BlockerProposal={
 key:string;jobVersion:number;blocker:string;mode:'record_update'|'resume_work';note:string;cleared:boolean;state:'draft'|'applying'|'applied';
};
export const blockerDrafts=pgTable('relay_blocker_drafts',{
 jobId:text('job_id').primaryKey(),revision:integer().notNull(),proposal:jsonb().$type<BlockerProposal>().notNull(),
});
