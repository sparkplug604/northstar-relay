import { defineAction } from "@agent-native/core/action";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readBoard, refs, updateDraft } from "../server/recovery/board.js";

export default defineAction({
  description: "Save a candidate visit move on the shared board and return its conflict flags. This edits the draft only.",
  schema: z.object({
    revision: z.number().int().nonnegative().describe("Exact current draft revision"),
    externalId: z.enum(refs).describe("Reference of an unpinned visit"),
    scheduledAt: z.iso.datetime({ offset: true }).describe("Exact proposed time in ISO 8601"),
    reason: z.string().trim().min(3).max(500).describe("Reason for the proposed move"),
  }),
  deferLoading: false,
  run: async ({ revision, ...proposal }) => {
    const board = await readBoard();
    const visit = board.visits.find((job) => job.externalId === proposal.externalId);
    if (!visit || board.draft.fields.pins.includes(proposal.externalId)) throw new Error("That visit is pinned or unavailable.");
    await updateDraft(revision, { ...board.draft.fields, proposal: { ...proposal, jobId: visit.id, jobVersion: visit.version, key: randomUUID() } });
    return readBoard();
  },
});
