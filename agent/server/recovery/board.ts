import { createGetDb } from "@agent-native/core/db";
import { and, eq } from "drizzle-orm";
import { drafts, type Draft } from "../db/schema.js";
import { readSeededJob, jobUrl } from "./relay.js";

const db = createGetDb({ drafts });
const id = "pine-recovery";
export const refs = ["SCHEDULE-202", "REQUEST-201"] as const;
const minute = 60000;
const overlaps = (a: number, b: number, start: number, end: number) => a < end && b > start;

export function approvalNote(proposal: NonNullable<Draft["proposal"]>) {
  return `Recovery board · ${proposal.reason} [${proposal.key}]`;
}

export async function readBoard() {
  const [[draft], incident, ...details] = await Promise.all([
    db().select().from(drafts).where(eq(drafts.id, id)),
    readSeededJob("DELAY-204"),
    ...refs.map(readSeededJob),
  ]);
  if (!draft) throw new Error("Recovery draft is missing.");
  const callback = incident.milestones.find((item) => item.title === "Call customer with repair ETA");
  if (!callback) throw new Error("Synthetic callback is missing.");
  const visits = details.map(({ job }) => ({ ...job, source: jobUrl(job.id) }));
  const proposal = draft.fields.proposal;
  const target = details.find(({ job }) => job.externalId === proposal?.externalId);
  const receipt = proposal && target
    ? target.events.find((event) => event.kind === "job_scheduled" && event.note === approvalNote(proposal)) ?? null
    : null;
  const due = Date.parse(callback.dueAt);
  const flags: string[] = [];
  if (proposal && target && !receipt) {
    const start = Date.parse(proposal.scheduledAt);
    const end = start + 20 * minute;
    if (draft.fields.pins.includes(proposal.externalId)) flags.push("The dispatcher pinned this visit.");
    if (target.job.id !== proposal.jobId || target.job.version !== proposal.jobVersion) flags.push("The Relay job changed. Refresh the proposal.");
    if (target.job.scheduledAt && start === Date.parse(target.job.scheduledAt)) flags.push("That is already the visit’s current time.");
    if (start <= Date.now()) flags.push("Choose a time in the future.");
    if (visits.some((job) => {
      if (job.id === target.job.id || job.assigneeId !== target.job.assigneeId || !job.scheduledAt) return false;
      const otherStart = Date.parse(job.scheduledAt);
      return overlaps(start, end, otherStart, otherStart + 20 * minute);
    })) flags.push("This overlaps the technician’s other visit.");
    if (callback.status === "open" && overlaps(start, end, due - 15 * minute, due)) {
      flags.push("This overlaps the 15 minutes reserved for the Pine Grocery callback.");
    }
  }
  const suggestedTimes = Object.fromEntries(visits.map((job) => {
    const first = Math.max(due + 5 * minute, Date.now() + 20 * minute);
    let start = Math.ceil(first / minute) * minute;
    while ((job.scheduledAt && Math.abs(start - Date.parse(job.scheduledAt)) < minute) || visits.some((other) => {
      if (other.id === job.id || other.assigneeId !== job.assigneeId || !other.scheduledAt) return false;
      const otherStart = Date.parse(other.scheduledAt);
      return overlaps(start, start + 20 * minute, otherStart, otherStart + 20 * minute);
    })) start += 20 * minute;
    return [job.externalId, new Date(start).toISOString()];
  }));
  const firstUnpinned = visits.find((visit) => !draft.fields.pins.includes(visit.externalId));
  return { draft, incident: { ...incident.job, source: jobUrl(incident.job.id) }, visits, callback, flags, receipt,
    suggestedTimes, suggestedAt: firstUnpinned ? suggestedTimes[firstUnpinned.externalId] : undefined };
}

export async function updateDraft(revision: number, fields: Draft) {
  const [updated] = await db().update(drafts).set({ fields, revision: revision + 1 })
    .where(and(eq(drafts.id, id), eq(drafts.revision, revision))).returning();
  if (!updated) throw new Error("The shared draft changed. Read it again before editing.");
  return updated;
}
