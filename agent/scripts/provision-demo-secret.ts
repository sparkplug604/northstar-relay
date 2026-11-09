import { writeAppSecret } from "@agent-native/core/secrets";
import { closeDbExec } from "@agent-native/core/db";

let value = "";
for await (const chunk of process.stdin) value += chunk;
if (!value.trim()) throw new Error("Pass the synthetic dispatcher password on stdin.");
try {
  await writeAppSecret({
    key: "RELAY_SYNTHETIC_DISPATCHER", scope: "workspace", scopeId: "relay-recovery-local", value: value.trim(),
  });
} finally {
  await closeDbExec();
}
