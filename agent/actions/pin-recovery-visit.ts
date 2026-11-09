import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { readBoard, refs, updateDraft } from "../server/recovery/board.js";

export default defineAction({
  description: "Set or remove a dispatcher’s pin on a visit.",
  uiOnly: true,
  agentTool: false,
  schema: z.object({ revision: z.number().int().nonnegative(), externalId: z.enum(refs), pinned: z.boolean() }),
  run: async ({ revision, externalId, pinned }) => {
    const { draft } = await readBoard();
    const pins = draft.fields.pins.filter((item) => item !== externalId);
    if (pinned) pins.push(externalId);
    return updateDraft(revision, { ...draft.fields, pins });
  },
});
