import assert from "node:assert/strict";
import test from "node:test";
import { validateCommitmentConfiguration } from "../src/index.js";
import { at, policy, recipients } from "./helpers.js";

test("a valid policy schedules a terminal contact no later than the deadline", () => {
  assert.doesNotThrow(() => validateCommitmentConfiguration(at(0), at(900), policy, recipients));
});

test("a step after the deadline is rejected", () => {
  const invalid = {
    ...policy,
    steps: policy.steps.map((step, index) => index === policy.steps.length - 1 ? { ...step, offsetSeconds: 901 } : step),
  };
  assert.throws(
    () => validateCommitmentConfiguration(at(0), at(900), invalid, recipients),
    /after the commitment deadline/,
  );
});

test("only the final step may be the required terminal step", () => {
  const nonTerminal = {
    ...policy,
    steps: policy.steps.map((step) => ({ ...step, terminal: false })),
  };
  assert.throws(
    () => validateCommitmentConfiguration(at(0), at(900), nonTerminal, recipients),
    /final escalation step must be terminal/,
  );
});

test("policy recipients must exist in the immutable recipient snapshot", () => {
  const missing = {
    ...policy,
    steps: policy.steps.map((step, index) => index === 0 ? { ...step, recipientIds: ["missing"] } : step),
  };
  assert.throws(
    () => validateCommitmentConfiguration(at(0), at(900), missing, recipients),
    /unknown recipient missing/,
  );
});

test("runtime policy data cannot introduce an unsupported delivery channel", () => {
  const invalid = { ...policy, steps: policy.steps.map((step) => ({ ...step, channels: ["unknown"] })) };
  assert.throws(() => validateCommitmentConfiguration(at(0), at(900), invalid as unknown as typeof policy, recipients), /sms or voice/);
});
