import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";

export const RELAY_EMAIL_PARSER_VERSION = "relay-email-v1.0";
export const MAX_EMAIL_BYTES = 512 * 1024;

export interface ParsedWorkOrder {
  externalId: string;
  customerReference: string;
  priority: string;
  dueAt: string;
  sourceReceivedAt: string;
  note: string;
}

export interface EmailCandidate {
  status: "parsed" | "needs_review";
  parserVersion: string;
  contentHash: string;
  receivedAt: string;
  messageId: string | null;
  sender: string | null;
  fields: Partial<ParsedWorkOrder>;
  provenance: Record<string, { source: string; value: string }>;
  reasons: string[];
}

function zonedTime(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const calendarDay = new Date(`${value.slice(0,10)}T00:00:00Z`);
  if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0,10) !== value.slice(0,10)) return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? new Date(date).toISOString() : null;
}

/** Only the documented Relay interchange template is certified by local fixtures.
 * ServiceChannel/Corrigo templates remain unsupported until real sanitized samples exist.
 * allowedSenders is an additional check, NOT authentication of a received connection.
 */
export async function parseRelayEmail(
  raw: string | Buffer,
  receivedAt: string,
  allowedSenders: readonly string[] = [],
): Promise<EmailCandidate> {
  if (!zonedTime(receivedAt)) throw new Error("A trusted zoned receipt time is required");
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (bytes.length > MAX_EMAIL_BYTES) throw new Error("Email exceeds 512 KiB intake limit");
  const result: EmailCandidate = {
    status: "needs_review", parserVersion: RELAY_EMAIL_PARSER_VERSION,
    contentHash: createHash("sha256").update(bytes).digest("hex"), receivedAt,
    messageId: null, sender: null, fields: {}, provenance: {}, reasons: [],
  };
  let mail;
  try {
    mail = await simpleParser(bytes, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  } catch {
    result.reasons.push("malformed_mime");
    return result;
  }
  result.messageId = mail.messageId ?? null;
  result.sender = mail.from?.value[0]?.address?.toLowerCase() ?? null;
  if (allowedSenders.length && !allowedSenders.map(value => value.toLowerCase()).includes(result.sender ?? "")) result.reasons.push("sender_not_allowed");
  if (mail.headers.get("x-northstar-template") !== "relay-v1") result.reasons.push("unsupported_template");
  if (mail.attachments.length) result.reasons.push("attachments_require_review");
  if (!mail.text) result.reasons.push("plain_text_required");
  const labels: Record<string, keyof ParsedWorkOrder> = {
    "work-order": "externalId", customer: "customerReference", priority: "priority",
    "due-at": "dueAt", "source-received-at": "sourceReceivedAt", note: "note",
  };
  const values = new Map<string, string>();
  for (const line of (mail.text ?? "").split(/\r?\n/)) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const label = match[1]!.toLowerCase();
    if (!(label in labels)) continue;
    if (values.has(label)) result.reasons.push(`duplicate_field:${label}`);
    values.set(label, match[2]!.trim());
  }
  for (const [label, key] of Object.entries(labels)) {
    const value = values.get(label);
    if (!value && key !== "note") { result.reasons.push(`missing_field:${label}`); continue; }
    if (!value) continue;
    const normalized = key === "dueAt" || key === "sourceReceivedAt" ? zonedTime(value) : value;
    if (normalized === null || value.length > (key === "note" ? 4000 : key === "priority" ? 80 : 200)) {
      result.reasons.push(`invalid_field:${label}`); continue;
    }
    result.fields[key] = normalized;
    result.provenance[key] = { source: `text:${label}`, value };
  }
  if (result.fields.sourceReceivedAt && result.fields.dueAt && result.fields.dueAt <= result.fields.sourceReceivedAt) result.reasons.push("deadline_not_after_source_time");
  if (result.fields.sourceReceivedAt && Date.parse(result.fields.sourceReceivedAt) > Date.parse(receivedAt)) result.reasons.push("future_source_time");
  if (result.reasons.length === 0) {
    result.fields.note ??= "";
    result.status = "parsed";
  }
  return result;
}
