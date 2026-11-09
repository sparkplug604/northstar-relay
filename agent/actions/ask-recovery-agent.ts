import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { readBoard, refs } from "../server/recovery/board.js";
import proposeMove from "./propose-recovery-move.js";

const answer = z.object({ externalId: z.enum(refs).optional(), message: z.string().trim().min(3).max(500) });

export default defineAction({
  description: "Ask the local recovery agent to propose or explain one shared draft. It cannot apply Relay changes.",
  agentTool: false,
  schema: z.object({ revision: z.number().int().nonnegative(), task: z.enum(["propose", "check"]) }),
  run: async ({ revision, task }) => {
    const board = await readBoard();
    if (board.draft.revision !== revision) throw new Error("The draft changed. Review it before asking again.");
    if (task === "check") {
      return { message: board.flags.join(" ") || "The current draft has no modeled conflicts." };
    }
    const available = board.visits.filter((visit) => !board.draft.fields.pins.includes(visit.externalId));
    if (!available.length) throw new Error("Both visits are pinned.");
    const facts = {
      task,
      incident: "Pine Grocery is waiting for a replacement fan ETA",
      callbackDue: board.callback.dueAt,
      available: available.map(({ externalId, customerReference, scheduledAt }) => ({ externalId, customerReference, scheduledAt })),
      suggestedAt: board.suggestedAt,
      proposal: board.draft.fields.proposal?.scheduledAt,
      conflictFlags: board.flags,
    };
    const response = await fetch("http://127.0.0.1:11435/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(50000),
      body: JSON.stringify({
        model: "qwen2.5:1.5b",
        stream: false,
        format: {
          type: "object",
          properties: {
            externalId: { type: "string", enum: available.map((visit) => visit.externalId) },
            message: { type: "string" },
          },
          required: ["externalId", "message"],
          additionalProperties: false,
        },
        options: { temperature: 0, num_ctx: 2048, num_predict: 80, num_gpu: 0 },
        messages: [
          { role: "system", content: "Choose the first available visit. Explain in one plain-language sentence why moving it after the callback helps. Return JSON with externalId and message. The board shows exact times separately. Never mention field names or add facts." },
          { role: "user", content: JSON.stringify(facts) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Local recovery model unavailable (${response.status}).`);
    const result = await response.json();
    const reply = answer.parse(JSON.parse(result.message.content));
    if (!reply.externalId || !available.some((visit) => visit.externalId === reply.externalId)) {
      throw new Error("The agent did not select an available visit. Try again.");
    }
    await proposeMove.run({ revision, externalId: reply.externalId, scheduledAt: board.suggestedTimes[reply.externalId]!, reason: reply.message });
    return { message: reply.message };
  },
});
