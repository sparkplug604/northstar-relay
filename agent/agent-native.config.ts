import { defineAgentNativeConfig } from "@agent-native/core/config";

export default defineAgentNativeConfig({
  changelog: { enabled: false },
  harness: false,
  instructions: {runtime: "RELAY_AGENT.md", development: "AGENTS.md"},
});
