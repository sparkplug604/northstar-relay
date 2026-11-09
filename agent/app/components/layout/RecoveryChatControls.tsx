import { useActionMutation, useActionQuery } from "@agent-native/core/client/hooks";
import { useState } from "react";
import { RecoveryReceipt } from "./RecoveryReceipt";

const pacific = new Intl.DateTimeFormat("en-CA", {
  hour: "numeric", minute: "2-digit", timeZone: "America/Vancouver",
});

export function RecoveryChatControls() {
  const board = useActionQuery("read-recovery-board", {});
  const revise = useActionMutation("ask-recovery-agent");
  const apply = useActionMutation("apply-recovery-move");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ message: string; historyUrl?: string } | null>(null);
  const state = board.data;
  if (!state) return (
    <section className="recovery-chat-controls" aria-label="Chat schedule controls">
      <p role="status">{board.error ? "Couldn’t load the Relay draft." : "Loading the Relay draft…"}</p>
      {board.error && <button type="button" onClick={() => void board.refetch()}>Retry loading</button>}
    </section>
  );

  const { draft, flags, receipt } = state;
  const proposal = draft.fields.proposal;
  const visit = state.visits.find((item) => item.externalId === proposal?.externalId);

  async function change(operation: () => Promise<unknown>, failureMessage: string) {
    setWorking(true);
    setError("");
    setNotice(null);
    try {
      await operation();
    } catch {
      setError(failureMessage);
    } finally {
      await board.refetch();
      setWorking(false);
    }
  }

  return (
    <section className="recovery-chat-controls" aria-label="Chat schedule controls">
      <strong>Schedule draft</strong>
      {proposal && visit && !receipt && <p>{visit.customerReference.split(" — ")[0]} · {visit.scheduledAt ? pacific.format(new Date(visit.scheduledAt)) : "Unscheduled"} → {pacific.format(new Date(proposal.scheduledAt))} Pacific · rev {draft.revision}</p>}
      {flags.length > 0 && <div id="chat-approval-blockers"><strong>Approval blocked</strong><ul>{flags.map((flag) => <li key={flag}>{flag}</li>)}</ul></div>}
      {receipt && visit ? <RecoveryReceipt event={receipt} href={visit.source} /> :
        <div className="recovery-chat-buttons">
          <button type="button" disabled={working} onClick={() => void change(() =>
            revise.mutateAsync({ revision: draft.revision, task: "propose" }), "The agent couldn’t revise this draft. Try Ask agent to revise again.",
          )}>{proposal ? "Ask agent to revise" : "Ask agent for a move"}</button>
          <button type="button" disabled={working || !proposal || flags.length > 0}
            aria-describedby={flags.length ? "chat-approval-blockers" : undefined}
            onClick={() => void change(async () => {
              try {
                const result = await apply.mutateAsync({ revision: draft.revision });
                if (result.outcome !== "applied") setNotice(result);
              } catch {
                setNotice({
                  message: "Approval could not be confirmed. Check Relay history before retrying.",
                  ...(visit && { historyUrl: visit.source }),
                });
              }
            }, "Approval could not be confirmed. Check the refreshed draft and Relay history before retrying.")}>
            Approve &amp; apply in Relay
          </button>
        </div>}
      {working && <p role="status">{apply.isPending ? "Applying this revision in Relay…" : "Revising the shared draft…"}</p>}
      {notice && !receipt && <p role="alert">{notice.message} {notice.historyUrl && <a href={notice.historyUrl} target="_blank" rel="noreferrer">Open Relay job history ↗</a>}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
