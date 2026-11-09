import assert from "node:assert/strict";
import test from "node:test";
import twilio from "twilio";
import {
  actionTokenHash, backupDeletionDeadline, DefiniteDeliveryFailure, dtmfAction, MAX_EMAIL_BYTES,
  mustBlockRestoredTenant, opaqueActionToken, parseRelayEmail, RelayTwilioProvider,
  verifyRelayTwilioCallback, type RelayDelivery, type RelayTwilioClient, type RelayTwilioConfig,
} from "../packages/relay-adapters/src/index.js";

const config: RelayTwilioConfig = { accountSid: `AC${"a".repeat(32)}`, authToken: "synthetic-test-key-never-real", fromNumber: "+16045550199", publicOrigin: "https://relay.example.invalid", allowedNumbers: ["+16045550100"] };
const delivery = (channel: "sms" | "voice"): RelayDelivery => ({ attemptId: "test-attempt-123456", channel, destination: config.allowedNumbers[0]!, locale: "en", actionToken: opaqueActionToken() });
const sample = (body: string, headers = "X-Northstar-Template: relay-v1\r\nContent-Type: text/plain; charset=utf-8"): string => `From: dispatch@example.invalid\r\nTo: relay@example.invalid\r\nMessage-ID: <fixture@example.invalid>\r\n${headers}\r\n\r\n${body}`;
const fields = "Work-Order: WO-123\r\nCustomer: Grocery fixture\r\nPriority: Emergency\r\nDue-At: 2026-09-06T00:00:00Z\r\nSource-Received-At: 2026-09-05T00:00:00Z\r\nNote: Test walk-in";

test("Relay provider sends generic English/French messages and opaque callback references", async () => {
  const calls: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const client: RelayTwilioClient = { calls: { async create(payload) { calls.push(payload); return { sid: `CA${"b".repeat(32)}` }; } }, messages: { async create(payload) { messages.push(payload); return { sid: `SM${"c".repeat(32)}` }; } } };
  const provider = new RelayTwilioProvider(config, client);
  const sms = { ...delivery("sms"), customerName: "SECRET CUSTOMER", workOrderNote: "SECRET LOCATION", locale: "fr" as const };
  await provider.send(sms);
  await provider.send(delivery("voice"));
  assert.match(String(messages[0]!.body), /une demande attend un responsable/);
  assert.match(String(messages[0]!.body), /\/relay\/action\//);
  assert.match(String(calls[0]!.twiml), /<Gather/);
  assert.match(String(calls[0]!.twiml), /input="dtmf"/);
  assert.ok(!JSON.stringify({ calls, messages }).includes("SECRET"));
  assert.ok(!JSON.stringify({ calls, messages }).includes(config.authToken));
  assert.equal(messages[0]!.to, config.allowedNumbers[0]);
});

test("provider allowlist and capability validation fail before network access", async () => {
  let requests = 0;
  const endpoint = { async create() { requests += 1; return { sid: "unused" }; } };
  const provider = new RelayTwilioProvider(config, { calls: endpoint, messages: endpoint });
  await assert.rejects(provider.send({ ...delivery("voice"), destination: "+16045550101" }), DefiniteDeliveryFailure);
  await assert.rejects(provider.send({ ...delivery("sms"), actionToken: "short" }), DefiniteDeliveryFailure);
  assert.equal(requests, 0);
});

test("provider distinguishes definite rejection from uncertain timeout or server response", async () => {
  for (const status of [400, 403, 429, 408, 500, undefined]) {
    const endpoint = { async create(): Promise<{ sid: string }> { throw Object.assign(new Error("opaque provider error"), status === undefined ? {} : { status }); } };
    const provider = new RelayTwilioProvider(config, { calls: endpoint, messages: endpoint });
    await assert.rejects(provider.send(delivery("voice")), error => {
      const definite = status !== undefined && status >= 400 && status < 500 && status !== 408;
      assert.equal(error instanceof DefiniteDeliveryFailure, definite);
      if (!definite) assert.equal((error as Error).message, "provider_outcome_uncertain");
      return true;
    });
  }
});

test("signature validation binds account, exact public URL and form fields", () => {
  const path = "/api/relay/v1/providers/twilio/test-attempt/status";
  const body = { AccountSid: config.accountSid, CallSid: `CA${"d".repeat(32)}`, CallStatus: "completed" };
  const signature = twilio.getExpectedTwilioSignature(config.authToken, config.publicOrigin + path, body);
  assert.equal(verifyRelayTwilioCallback(config, path, signature, body), true);
  assert.equal(verifyRelayTwilioCallback(config, path + "?different=1", signature, body), false);
  assert.equal(verifyRelayTwilioCallback(config, path, signature, { ...body, AccountSid: `AC${"e".repeat(32)}` }), false);
  assert.equal(verifyRelayTwilioCallback(config, path, "invalid", body), false);
});

test("capability hashes differ from opaque tokens and only explicit digits create actions", () => {
  const token = opaqueActionToken();
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.notEqual(token, actionTokenHash(token));
  assert.equal(dtmfAction("1"), "acknowledge");
  assert.equal(dtmfAction("9"), "decline");
  for (const value of [undefined, "", "answered", "11", "0"]) assert.equal(dtmfAction(value), null);
});

test("retention cannot exceed 30 days and deletion tombstones block restoration", () => {
  assert.equal(backupDeletionDeadline("2026-09-05T08:00:00.000Z"), "2026-10-05T08:00:00.000Z");
  for (const days of [0, 31, 1.5, Number.NaN]) assert.throws(() => backupDeletionDeadline("2026-09-05T08:00:00Z", days));
  assert.equal(mustBlockRestoredTenant("deleted", new Set(["deleted"])), true);
  assert.equal(mustBlockRestoredTenant("active", new Set(["deleted"])), false);
});

test("recognized intake template yields source-linked deterministic fields", async () => {
  const candidate = await parseRelayEmail(sample(fields), "2026-09-05T01:00:00.000Z", ["dispatch@example.invalid"]);
  assert.equal(candidate.status, "parsed");
  assert.equal(candidate.fields.externalId, "WO-123");
  assert.equal(candidate.fields.dueAt, "2026-09-06T00:00:00.000Z");
  assert.deepEqual(candidate.provenance.externalId, { source: "text:work-order", value: "WO-123" });
  assert.match(candidate.contentHash, /^[0-9a-f]{64}$/);
});

test("unknown, duplicate-field, unzoned, HTML-only and untrusted-sender intake stays in review", async () => {
  const samples = [
    sample(fields, "Content-Type: text/plain"), sample(fields + "\r\nWork-Order: DIFFERENT"),
    sample(fields.replace("2026-09-06T00:00:00Z", "2026-09-06 00:00")),
    sample("<h1>Work order</h1>", "Content-Type: text/html"),
  ];
  for (const raw of samples) assert.equal((await parseRelayEmail(raw, "2026-09-05T01:00:00.000Z")).status, "needs_review");
  assert.equal((await parseRelayEmail(sample(fields), "2026-09-05T01:00:00.000Z", ["other@example.invalid"])).status, "needs_review");
});

test("parser rejects oversized input and marks incomplete MIME for review", async () => {
  await assert.rejects(parseRelayEmail(Buffer.alloc(MAX_EMAIL_BYTES + 1), "2026-09-05T01:00:00.000Z"), /512 KiB/);
  await assert.rejects(parseRelayEmail(sample(fields), "not-a-time"), /trusted zoned receipt/);
  assert.equal((await parseRelayEmail("", "2026-09-05T01:00:00.000Z")).status, "needs_review");
});

test("MIME attachments cannot automatically create an active commitment", async () => {
  const multipart = sample(`--test-boundary\r\nContent-Type: text/plain\r\n\r\n${fields}\r\n--test-boundary\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="details.txt"\r\n\r\nattachment body\r\n--test-boundary--`, "X-Northstar-Template: relay-v1\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=test-boundary");
  const candidate = await parseRelayEmail(multipart, "2026-09-05T01:00:00.000Z");
  assert.equal(candidate.status, "needs_review");
  assert.ok(candidate.reasons.includes("attachments_require_review"));
});

test("parser rejects impossible calendar dates and fields that promotion cannot accept", async () => {
  const invalidDate = fields.replace("2026-09-06T00:00:00Z", "2026-02-30T00:00:00Z").replace("2026-09-05T00:00:00Z", "2026-02-28T00:00:00Z");
  assert.equal((await parseRelayEmail(sample(invalidDate), "2026-03-01T00:00:00.000Z")).status, "needs_review");
  assert.equal((await parseRelayEmail(sample(fields.replace("Priority: Emergency", `Priority: ${"x".repeat(120)}`)), "2026-09-05T01:00:00.000Z")).status, "needs_review");
});
