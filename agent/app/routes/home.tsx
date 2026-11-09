import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import { useActionMutation, useActionQuery } from "@agent-native/core/client/hooks";
import { useState } from "react";
import { TAB_ID } from "@/lib/tab-id";
import "../recovery.css";
import { RecoveryReceipt } from "@/components/layout/RecoveryReceipt";

const clock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Vancouver", hour: "numeric", minute: "2-digit",
});
const time = (value: string | null) => value ? clock.format(new Date(value)) : "Unscheduled";
type VisitRef = "SCHEDULE-202" | "REQUEST-201";

export function meta() {
  return [{ title: "Northstar Relay · Shift Recovery" }];
}

export default function HomeRoute() {
  const board = useActionQuery("read-recovery-board", {});
  const propose = useActionMutation("propose-recovery-move");
  const pin = useActionMutation("pin-recovery-visit");
  const apply = useActionMutation("apply-recovery-move");
  const consult = useActionMutation("ask-recovery-agent");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [approvalNotice, setApprovalNotice] = useState<{ message: string; historyUrl?: string } | null>(null);
  const [advice, setAdvice] = useState<{ revision: number; message: string } | null>(null);

  async function change(operation: () => Promise<unknown>, failureMessage?: string) {
    setPending(true);
    setError("");
    setApprovalNotice(null);
    try {
      await operation();
    } catch (failure) {
      setError(failureMessage ?? (failure instanceof Error ? failure.message : String(failure)));
    } finally {
      await board.refetch();
      setPending(false);
    }
  }

  const state = board.data;
  const draft = state?.draft;
  const proposal = draft?.fields.proposal;
  const target = state?.visits.find((visit) => visit.externalId === proposal?.externalId);
  const receipt = state?.receipt;
  function openChat() {
    if (!state || !draft) return;
    const pinned = state.visits.filter((visit) => draft.fields.pins.includes(visit.externalId))
      .map((visit) => visit.customerReference.split(" — ")[0]);
    const task = receipt
      ? "Review the applied schedule change. Summarize which visit moved, how it affects the Pine Grocery callback, and what dispatch should verify next. Leave the board as it is."
      : "Help recover the shift after the Pine Grocery repair was blocked. Compare the Harbour Market and Cedar Shop visits, respect dispatcher pins, and explain which move protects the callback. Flag any conflict in the current draft before suggesting a change.";
    sendToAgentChat({
      message: `First call read-recovery-board to check the latest schedule and draft. ${task}`,
      openSidebar: true,
      chatTarget: "local",
      submit: false,
      engine: "ai-sdk:ollama",
      model: "qwen2.5:1.5b",
      tabId: TAB_ID,
      context: `Shift recovery · Pine Grocery callback due ${time(state.callback.dueAt)} Pacific. Pinned visits: ${pinned.join(", ") || "none"}. Read the live board before reasoning. The dispatcher alone approves changes in Relay.`,
      contextLabel: "Pine Grocery shift recovery",
      actionScope: { kind: "relay-recovery" },
    });
  }

  function ask(task: "propose" | "check") {
    if (!draft) return;
    void change(async () => {
      const result = await consult.mutateAsync({ revision: draft.revision, task });
      if (task === "check") setAdvice({ revision: draft.revision, message: result.message });
    }, task === "propose" ? "The agent couldn’t revise this draft. Try Ask agent to revise again." : undefined);
  }

  return (
    <main className="recovery">
      <header className="recovery-head">
        <p className="recovery-kicker">NORTHSTAR RELAY / DISPATCH</p>
        <a href="http://127.0.0.1:3004/relay" target="_top">← Back to Relay dashboard</a>
        <h1>Shift recovery</h1>
        <p>Work the disruption with your agent. Review the tradeoff before moving a visit.</p>
        <span className="recovery-badge">SYNTHETIC WORKSPACE</span>
      </header>
      {!state || !draft ? <p role="status">{board.error ? <>Couldn’t load the Relay board. <button onClick={() => void board.refetch()}>Retry loading</button></> : "Loading the Relay board…"}</p> : <>
        <section className="recovery-incident" aria-label="Active disruption">
          <div>
            <p className="recovery-kicker">ACTIVE DISRUPTION · {state.incident.externalId}</p>
            <h2>{state.incident.customerReference}</h2>
            <p>{state.incident.blocker}</p>
            <a href={state.incident.source} target="_blank" rel="noreferrer">Open incident ↗</a>
          </div>
          <div>
            <p className="recovery-kicker">PROMISE TO PROTECT</p>
            <strong>{state.callback.title}</strong>
            <p>Due {time(state.callback.dueAt)} Pacific</p>
          </div>
        </section>
        <section aria-labelledby="visits-title">
          <div className="recovery-row">
            <div><p className="recovery-kicker">01 · LIVE FROM RELAY</p><h2 id="visits-title">Visits on the board</h2></div>
            <button className="recovery-primary" disabled={pending} onClick={() => ask("propose")}>
              {proposal ? "Ask agent to revise" : "Ask agent for a move"}
            </button>
          </div>
          <div className="recovery-visits">
            {state.visits.map((job) => {
              const pinned = draft.fields.pins.includes(job.externalId);
              return (
                <article className="recovery-card" key={job.id}>
                  <p className="recovery-kicker">{job.externalId}</p>
                  <h3>{job.customerReference}</h3>
                  <p><strong>{time(job.scheduledAt)}</strong> Pacific</p>
                  <div className="recovery-row">
                    <a href={job.source} target="_blank" rel="noreferrer">Source job ↗</a>
                    <button aria-pressed={pinned} disabled={pending} onClick={() => void change(() =>
                      pin.mutateAsync({ revision: draft.revision, externalId: job.externalId as VisitRef, pinned: !pinned }),
                    )}>{pinned ? "Pinned · Unlock" : "Pin visit"}</button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
        <section className="recovery-card" aria-labelledby="draft-title">
          <p className="recovery-kicker">02 · SHARED DRAFT · REV {draft.revision}</p>
          <h2 id="draft-title">Proposed move</h2>
          {!proposal || !target ? <p>Ask the agent for a move to put a proposal on the board.</p> : <>
            <h3>{target.customerReference}</h3>
            <p>{time(typeof receipt?.details.previousScheduledAt === "string" ? receipt.details.previousScheduledAt : target.scheduledAt)} → <strong>{time(proposal.scheduledAt)} Pacific</strong></p>
            <p><strong>Reason for the move</strong><br />{proposal.reason}</p>
            {!receipt && state.flags.length > 0 && (
              <div id="recovery-approval-blockers" className="recovery-flags">
                <strong>Approval blocked</strong>
                <ul>{state.flags.map((flag) => <li key={flag}>{flag}</li>)}</ul>
              </div>
            )}
            {!receipt && <div className="recovery-controls">
              <button disabled={pending} onClick={() => ask("propose")}>Ask agent to revise</button>
              <button disabled={pending || draft.fields.pins.includes(proposal.externalId)} onClick={() => void change(() =>
                propose.mutateAsync({
                  revision: draft.revision, externalId: proposal.externalId as VisitRef,
                  scheduledAt: new Date(Date.parse(proposal.scheduledAt) - 15 * 60000).toISOString(),
                  reason: "Dispatcher is testing a 15-minute earlier start.",
                }),
              )}>Move 15 min earlier</button>
              <button disabled={pending} onClick={() => ask("check")}>Ask agent to check</button>
              <button className="recovery-primary" aria-describedby={state.flags.length ? "recovery-approval-blockers" : undefined} disabled={pending || state.flags.length > 0} onClick={() => void change(() =>
                apply.mutateAsync({ revision: draft.revision }).then((result) => {
                  if (result.outcome !== "applied") setApprovalNotice(result);
                }).catch(() => setApprovalNotice({ message: "Approval could not be confirmed. Check Relay history before retrying.", historyUrl: target.source })),
              )}>Approve & apply in Relay</button>
            </div>}
            {apply.isPending && <p role="status">Applying this revision in Relay…</p>}
            {receipt && <RecoveryReceipt event={receipt} href={target.source} />}
            {approvalNotice && !receipt && <p role="alert" className="recovery-flags">{approvalNotice.message} {approvalNotice.historyUrl && <a href={approvalNotice.historyUrl} target="_blank" rel="noreferrer">Open Relay job history ↗</a>}</p>}
          </>}
          {consult.isPending && <p role="status">The agent is reading the recovery board…</p>}
          {advice?.revision === draft.revision && !receipt && (
            <div className="recovery-advice" role="status">
              <p><strong>{state.flags.length ? "Resolve the conflict before applying" : "No modeled conflicts found"}</strong></p>
              <p>{advice.message}</p>
              <p><strong>Next step</strong><br />{state.flags.length ? "Ask agent to revise" : "Approve & apply in Relay"}</p>
            </div>
          )}
          <button className="recovery-chat" onClick={openChat}>Open agent chat</button>
          {error && <p role="alert" className="recovery-flags">{error}</p>}
        </section>
      </>}
    </main>
  );
}
