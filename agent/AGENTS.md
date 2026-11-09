# Ask Relay development

The embedded Agent-Native chat lives in `app/routes/dispatch.tsx`. Keep tool instructions in `RELAY_AGENT.md` and use `defineAction()` for application actions. Mutations use Relay's existing API, require approval where configured, and report success after a verified read.

Run the complete app through `../demo.sh`. That launcher generates the synthetic dispatcher credentials, starts the loopback services, and selects local Qwen. Run `pnpm typecheck`, `pnpm test`, and `pnpm agent-native:doctor` from this directory.
