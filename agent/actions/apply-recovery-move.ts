import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { approvalNote, readBoard } from "../server/recovery/board.js";
import { relay, type Detail } from "../server/recovery/relay.js";

export default defineAction({
  description: "Apply the exact draft revision approved by the dispatcher and return the persisted Relay schedule history event.",
  uiOnly: true,
  agentTool: false,
  toolCallable: false,
  schema: z.object({ revision: z.number().int().nonnegative() }),
  run: async ({ revision }) => {
    const { draft, visits, flags, receipt } = await readBoard();
    const { proposal } = draft.fields;
    if (!proposal || revision !== draft.revision) return { outcome: "stale", message: "The draft changed. Review the refreshed visit and times before approving again." } as const;
    const job = visits.find((item) => item.externalId === proposal.externalId);
    if (!job) throw new Error("The visit is unavailable.");
    if (receipt) return { outcome: "applied", event: receipt, historyUrl: job.source } as const;
    if (flags.length) return { outcome: "blocked", message: flags.join(" ") } as const;
    const note = approvalNote(proposal);
    try {
      const after = await relay<Detail>(`/jobs/${encodeURIComponent(job.id)}/actions`, {
        key: proposal.key,
        body: { action: "schedule", expectedVersion: proposal.jobVersion, scheduledAt: proposal.scheduledAt, note },
      });
      const event = after.events.find((item) => item.kind === "job_scheduled" && item.note === note);
      if (event) return { outcome: "applied", event, historyUrl: job.source } as const;
    } catch {
      // The request may have committed before its response failed.
    }

    const latest = await relay<Detail>(`/jobs/${encodeURIComponent(job.id)}`).catch(() => null);
    const event = latest?.events.find((item) => item.kind === "job_scheduled" && item.note === note);
    if (event) return { outcome: "applied", event, historyUrl: job.source } as const;
    if (latest && latest.job.version !== proposal.jobVersion) {
      return { outcome: "stale", message: "The Relay job changed. Ask for a revision and review the new time before approving." } as const;
    }
    return {
      outcome: "uncertain",
      message: "Relay did not confirm this change. Check the job’s History before approving again.",
      historyUrl: job.source,
    } as const;
  },
});
