const pacific = new Intl.DateTimeFormat("en-CA", {
  hour: "numeric", minute: "2-digit", timeZone: "America/Vancouver",
});

export function RecoveryReceipt({ event, href }: {
  event: { details: Record<string, unknown> };
  href: string;
}) {
  const { previousScheduledAt, scheduledAt } = event.details;
  const previous = typeof previousScheduledAt === "string" ? pacific.format(new Date(previousScheduledAt)) : "Unscheduled";
  return (
    <div role="status" className="recovery-receipt">
      <strong>Saved to Relay history.</strong>
      {typeof scheduledAt === "string" && <p>Recorded move {previous} → {pacific.format(new Date(scheduledAt))} Pacific</p>}
      <a href={href} target="_blank" rel="noreferrer">Open recorded change ↗</a>
    </div>
  );
}
