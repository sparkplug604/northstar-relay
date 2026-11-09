# Getting Started with Northstar Relay

[Download Northstar Relay Demo ZIP](https://github.com/sparkplug604/northstar-relay/releases/download/v0.1.0-demo/northstar-relay-demo.zip)

This is the runnable, local version of the hackathon demo. The ZIP includes the executable launcher and source. On first launch, it builds the app from locked dependencies, prepares the Qwen model, and seeds two synthetic jobs. Allow a few GB of free disk space, a network connection for setup, and time for the roughly 1.4 GB model download.

## macOS

1. Install Node.js 24 LTS and Ollama. Open Ollama once so its command-line tool is available. Ollama requires macOS 14 or newer. [Node.js downloads](https://nodejs.org/en/download) · [Ollama for macOS](https://docs.ollama.com/macos)
2. Extract the ZIP into a folder you own. Double-click **Start Northstar Relay.command** in the extracted folder. It opens Terminal, sets up the demo, then opens the sign-in page.
3. If you’re already in Terminal, open the extracted folder there and run:

   ```bash
   ./demo.sh launch
   ```

## Windows via WSL2 and Ubuntu Linux

On Windows, run the Linux launcher inside Ubuntu on WSL2. Set up Ubuntu first with `wsl --install -d Ubuntu` from PowerShell as an administrator and follow Microsoft’s prompts. Open Ubuntu and create a regular Linux user. On Ubuntu Linux, start at the next step. [Microsoft WSL setup](https://learn.microsoft.com/en-us/windows/wsl/install)

1. Install Node.js 24 LTS and Ollama **inside Ubuntu**. Install the tools needed to download and extract the ZIP. [Node.js downloads](https://nodejs.org/en/download) · [Ollama for Linux](https://docs.ollama.com/linux)

   ```bash
   sudo apt-get update
   sudo apt-get install -y curl unzip build-essential python3
   ```

2. Download and extract the ZIP into your Linux home folder and launch it as your regular user:

   ```bash
   cd ~
   curl -fL -o northstar-relay-demo.zip https://github.com/sparkplug604/northstar-relay/releases/download/v0.1.0-demo/northstar-relay-demo.zip
   unzip northstar-relay-demo.zip
   cd northstar-relay-demo
   ./demo.sh launch
   ```

3. Once Terminal prints **Sign in as Drew Dispatcher**, open the sign-in link in your browser. On Windows, open it in your Windows browser. [WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking)

## Sign in to the synthetic demo

Open [Northstar Relay sign-in](http://127.0.0.1:3004/relay/sign-in) and click **Sign in as Drew Dispatcher**. This signs you into the seeded dispatcher account without entering a password.

For manual sign-in, the email is `dispatch@relay-demo.invalid`. Run `./demo.sh credentials` from the extracted folder to display the password generated for this installation. The demo runs on your machine and uses simulated communications.

## Try the two demo workflows

The launcher prints job links and a target date. Your installation chooses upcoming working days, so your dates can differ from the recording.

1. **Parkside Foods.** Open Ask Relay on the job and ask it to set the client completion deadline to the printed target date at 6 p.m. Vancouver time. Review the approval card and click **Approve**.
2. **In the same chat**, ask Ask Relay to check Casey’s availability on that date and find a visit that finishes before 6 p.m. Approve the checked visit, close chat, and open **Job History** to see both changes.
3. **Harbour Market.** Open **Manage assignment → Change assignee → Choose a person manually**, select Riley, and save. Open Ask Relay and ask who’s assigned and when the visit is scheduled.

[Watch the recorded walkthrough](../README.md#watch-the-northstar-relay-demo)

## Stop, restart, or troubleshoot

- Run `./demo.sh stop` to stop the local services. Launch again to resume the saved jobs and conversations. To rehearse from the original seed again, extract a fresh copy after stopping the current demo.
- If the Mac launcher does not open, run `sh ./demo.sh launch` from the extracted folder in Terminal. If a tool is missing, check `node --version`, `npm --version`, and `ollama --version` there or in Ubuntu.
- If the launcher reports a port conflict, close the previous Relay demo before retrying. Relay uses ports 3004 and 3005 for the app and agent, 11435 for its local Ollama service, and 55482 for embedded PostgreSQL.
- For a startup error, check `runtime/logs/supervisor.log` and the service log it names. The first model download writes progress to the supervisor log. Map tiles and road estimates use OpenFreeMap and OSRM with synthetic job locations.

## Run from source or verify a download

You can clone this repository and run the same `./demo.sh launch` command from its root. Run `./demo.sh install` after changing the source to rebuild it.

With the demo running, `node demo/check-launch.mjs` checks the synthetic sign-in and seeded jobs. For the full browser rehearsal, install Google Chrome and run `node demo/verify.mjs` on a fresh seed. That test saves both Parkside changes and the Harbour Market reassignment.

Run `npm run build:all` in `relay/` and `pnpm typecheck && pnpm test && pnpm agent-native:doctor` in `agent/` for development checks. [Source map](../README.md#source-map)
