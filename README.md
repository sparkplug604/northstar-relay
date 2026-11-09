# Northstar Relay

**A user friendly dispatch app built with Agent Native.**

[Watch the 2:35 hackathon demo](https://github.com/sparkplug604/northstar-relay/releases/tag/hackathon-demo)

Northstar Relay helps service teams review work orders, assign technicians, schedule visits, and track repairs. When a deadline moves, a dispatcher needs a qualified technician, a workable opening, and time to travel and finish the job. **Ask Relay** brings those checks into the job page. The dispatcher can review a proposed change, approve it in chat, and see what was saved in Job History.

## What to look for

| Demo | What happens | What it proves |
| --- | --- | --- |
| **Parkside Foods** · 0:41–2:00 | Drew approves a November 10, 6 p.m. client deadline. In the same chat, he approves Casey’s checked 8:30 a.m. visit. Job History shows both changes under Drew’s name. | The agent helps work out the plan, the dispatcher makes both decisions, and the app records the result. |
| **Harbour Market** · 2:00–2:14 | Drew reassigns the job from Casey to Riley on the job page. Ask Relay reads back Riley and the existing 11 a.m. visit. | A direct UI edit is available to the agent on its next read. |

## Run the synthetic demo

Use macOS or Linux with Node.js 22.22 or newer, npm, pnpm 11, and Ollama. Run as a normal user so embedded PostgreSQL can initialize. The install downloads dependencies, and Qwen requires about 1.4 GB of model storage.

```bash
git clone https://github.com/sparkplug604/northstar-relay.git
cd northstar-relay
./demo.sh install

# With Ollama running on its default local port:
ollama pull qwen3:1.7b
ollama create qwen3-relay:1.7b -f demo/Qwen.Modelfile

./demo.sh start
./demo.sh credentials
```

Open [Relay Home](http://127.0.0.1:3004/relay) and sign in as the generated synthetic dispatcher. Startup prints links for Parkside Foods and Harbour Market, plus the target date for your seeded Parkside scenario. Dates are chosen at first startup so the scheduling exercise uses future working days.

1. On **Parkside Foods**, open **Ask Relay**. Ask it to set the client completion deadline to the printed target date at 6 p.m. Vancouver time. Review the approval card and click **Approve**.
2. In the same chat, ask it to check Casey’s availability on that date and propose a visit that finishes before 6 p.m. Approve the visit, close chat, and open **Job History**.
3. Open **Harbour Market**. Under **Manage assignment → Change assignee → Choose a person manually**, select Riley and save. Open **Ask Relay** and ask who’s assigned and when the visit is scheduled.

The demo runs on loopback and uses simulated communications. Map tiles load from OpenFreeMap. `./demo.sh stop` stops the owned services. `./demo.sh start` resumes saved jobs and chat. To rehearse from the original baseline again, use a fresh clone.

## How Agent-Native is integrated

The embedded Chat template receives the selected job as context. Typed Agent-Native actions call the same Relay API as the UI. Reads use the latest saved record. Write actions pause at native approval cards, then use Relay’s versioned mutations or checked assignment API. Relay verifies the updated record and history before reporting success.

- **Home triage and Jobs.** The priority view surfaces blockers and deadline risks. **Resolve with Relay** opens a job-scoped conversation. Ask Relay can read job details and saved contacts and can record a dispatcher-supplied client confirmation with approval.
- **Scheduling and assignment.** Planning uses client windows, required skills, technician hours and time off, and booked visits. The routing adapter supports road travel estimates when a routing service is configured. The job map and day/week calendar show where and when work is planned.
- **Shift recovery.** Dispatchers can pin visits that must stay in place, ask the agent to compare options, and approve a shared draft that saves to Relay.

## Source map

| Path | Purpose |
| --- | --- |
| [relay/](relay/) | Relay UI, API, domain rules, PostgreSQL migrations, and tests |
| [agent/actions/](agent/actions/) | Agent-Native actions for job reads, checked scheduling, and approved writes |
| [agent/app/routes/](agent/app/routes/) | Embedded Ask Relay, assignment, and recovery interfaces |
| [demo/](demo/) | Local service supervision, synthetic fixtures, Qwen configuration, and browser rehearsal |

Run `npm run build:all` in `relay/` and `pnpm typecheck && pnpm test && pnpm agent-native:doctor` in `agent/`. With the demo freshly seeded and Google Chrome installed, run `node demo/verify.mjs` from the root. The rehearsal saves the two Parkside approvals and the Harbour Market reassignment and checks the agent’s readback.

## What was built during the hackathon

The new work includes the embedded Ask Relay integrations, Home triage and job handoff, the recovery and checked scheduling workflows, technician planning constraints, maps and calendar views, and the synthetic demo and verification scripts.

The pre-existing Relay app supplied sign-in, intake and work-order acknowledgements, jobs, manual assignment and scheduling, commitments, and Job History.

## Third-party components

- Agent-Native 0.224.0 and its Chat template. [Framework](https://github.com/BuilderIO/agent-native) · [Upstream license](agent/UPSTREAM-LICENSE)
- Qwen3-1.7B and Ollama for local tool-calling inference. [Qwen3](https://huggingface.co/Qwen/Qwen3-1.7B) · [Ollama](https://github.com/ollama/ollama)
- MapLibre GL JS and OpenFreeMap tiles with OpenStreetMap data, FullCalendar, and the OSRM routing adapter. [MapLibre](https://github.com/maplibre/maplibre-gl-js) · [OpenFreeMap](https://openfreemap.org/) · [FullCalendar](https://github.com/fullcalendar/fullcalendar) · [OSRM](https://github.com/Project-OSRM/osrm-backend)
- The video uses synthetic jobs and real app footage. Narration was made in Voicebox using Kokoro’s Heart voice. Music and sound effects were synthesized for the video. [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)
