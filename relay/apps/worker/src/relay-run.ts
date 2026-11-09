import { RelaySimulatedProvider, RelayTwilioProvider } from "../../../packages/relay-adapters/src/twilio.js";
import { createRelayStore } from "../../../packages/relay-storage-postgres/src/store.js";
import { RelayEngine } from "./relay-engine.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const mode = process.env.RELAY_PROVIDER_MODE;
if (mode !== "simulated" && mode !== "live") throw new Error("Set RELAY_PROVIDER_MODE explicitly to simulated or live; delivery mode is never inferred");
if (mode === "simulated" && process.env.NODE_ENV === "production") throw new Error("Production Relay cannot silently simulate notification delivery");
const store = createRelayStore(required("RELAY_DATABASE_URL"));
const provider = mode === "simulated" ? new RelaySimulatedProvider() : new RelayTwilioProvider({
  accountSid: required("TWILIO_ACCOUNT_SID"), authToken: required("TWILIO_AUTH_TOKEN"),
  fromNumber: required("TWILIO_FROM_NUMBER"), publicOrigin: required("RELAY_PUBLIC_ORIGIN"),
  allowedNumbers: required("TWILIO_ALLOWED_TO_NUMBERS").split(",").map(value => value.trim()).filter(Boolean),
});
const intervalMilliseconds = Number(process.env.RELAY_WORKER_INTERVAL_MS ?? 1_000);
if (!Number.isInteger(intervalMilliseconds) || intervalMilliseconds < 100) throw new Error("RELAY_WORKER_INTERVAL_MS must be an integer of at least 100");
const engine = new RelayEngine(store, provider);
let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

try {
  await store.assertRestrictedRuntime();
  process.stdout.write(`${JSON.stringify({ service: "relay-worker", mode, status: "started" })}\n`);
  while (!stopping) {
    const result = await engine.runCycle();
    if (result.commitmentsExamined || result.attemptsClaimed || result.notificationsUncertain) process.stdout.write(`${JSON.stringify({ service: "relay-worker", mode, ...result })}\n`);
    if (!stopping) await new Promise(resolve => setTimeout(resolve, intervalMilliseconds));
  }
} finally {
  await store.close();
}
