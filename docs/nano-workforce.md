# cubefarm with nano-workforce behind it

`npx cubefarm --nano http://localhost:3000` (or `CUBEFARM_NANO_URL`) runs the office as an interface to a
[nano-workforce](https://github.com/nanobpm/nano-workforce) app. nano-workforce plans, implements, reviews and
merges; the office shows that work and drives it. Its own orchestrator stands down: no CEO sessions, no QA lab, no
local agent sessions, no auto-assign.

| In the office | From / to nano-workforce |
| --- | --- |
| A developer at a desk | A connected worker (`GET /app/api/agentic/supply`), on the floor of the repo its current job is for |
| What they're on (issue / PR, sign) | The job's correlation (`bpmnProcessId · elementId`, `planKey`) and the PR it holds (`GET /status`) |
| Their screen | The job's relay transcript (`GET /agentic/transcripts?stream=job:<key>`), polled |
| Handing a whiteboard sticky to any desk | `POST /actions/start/plan-fanout` for that issue |
| 🚨 on the phone + a needs-you notification | An open escalation (`GET /escalations`) |
| Texting `answer <id> [choice] note` | `POST /actions/complete-user-task` with the form's variables |
| Texting `status` | PRs in flight and open escalations |

Floors are still shown in the lobby, but nothing here touches GitHub: the office serves the whiteboard's issues and
PRs from what the bridge last saw (`FloorBook`, `server/nano/backend.ts`) and can't change GitHub — nano-workforce
does the work.
Hire workers with `c8ctl nano hire` / `c8 nano workforce`: they take a desk when they connect.

| env | default | |
| --- | --- | --- |
| `CUBEFARM_NANO_URL` | | the app's origin or console-proxy URL (`/app/api` is added) |
| `CUBEFARM_NANO_SECRET` | `NANO_PR_WEBHOOK_SECRET` | sent as `x-hook-secret` |
| `CUBEFARM_NANO_POLL_MS` | 5000 | |
| `CUBEFARM_NANO_BASE_BRANCH` | the repo's default branch (sent with `confirmDefaultBase`) | e.g. `epic/issue-{n}` |
| `CUBEFARM_NANO_AUTH` | from `user:pass@` in the URL | the app's `Authorization` header, e.g. `Basic …` |

## The CEO on nano-coder or Copilot

Settings → The CEO → **Runs on**: Claude Code (the default), nano-coder or GitHub Copilot CLI. The other two run as
`<cli> --acp` (Agent Client Protocol over stdio), with the CEO's model from the CEO tab (`--model`; empty: the
harness's own default). ACP has no system prompt, so the CEO's instructions go with each new session's first
prompt. nano-coder has no MCP, so the office tools are a shell command instead:
`node <SWARM_HOME>/bin/cubefarm-office.cjs <tool> '<json>'`, which posts to `/api/office/<session token>/<tool>`
(the CEO's instructions list the tools and their arguments).

With `--nano`, an ACP CEO also gets nano-workforce's agent skill (`GET /app/api/agent/skill`, same base URL and
auth, fetched again after ten minutes) in its instructions. Phone texts that aren't `status` / `answer` / `start` go to
it, and it drives nano-workforce through the skill. With Claude Code, or with `--demo`, nano mode has no real CEO
session, as before.

State lives in `nano-state.json` (`demo-nano-state.json` with `--demo`), apart from the usual office's.

Try it without anything real: `node scripts/fake-nano.mjs 4398`, then
`SWARM_HOME=$PWD/.swarm-home SWARM_PORT=<port> node --import tsx server/index.ts --demo --nano http://localhost:4398`.

## Notes from a live server (0.200.4)

- Workers' `identity` is often just `127.0.0.1`: the office names them from the instance id (`…-copilot-31c33e5f` →
  "copilot 31c3") and shows their declared family and host (`Opus 4.8 @ Joshs-MacBook-Pro.local`) as the job title.
- Correlations may carry only `jobKey` + `stream` (no process or plan): a worker is then placed by the PR it holds
  the lease on (`/status` `activeWorker`), and its sign reads `converging · round 13`. Workers on plan/feature jobs
  without a PR stay on their last floor.
- Transcripts are JSON lines (`nwfTranscriptEvent`) with assistant text streamed in fragments; the office joins them
  into lines and shows tool calls (with the command for harnesses that only say "bash").
- Escalation `formKey`s are numeric ids, so the answer form is picked by `kind`; delivery human-steps are answered
  with a `note`.
- **macOS:** a Node from nvm/Homebrew may be refused the local network (`EHOSTUNREACH` to a LAN address that curl
  reaches) until it's allowed in System Settings → Privacy & Security → Local Network. Meanwhile an SSH tunnel works:
  `ssh -fN -L 3300:localhost:3000 merlin.local` and `--nano http://localhost:3300`.

## The building: processes are floors (since the live-server run)

- **Floor 1, the bench**: workers holding no job.
- **One floor per running root process instance** (from the engine, `POST /v2/process-instances/search`):
  `convergence-loop/<repo>-pr<n>` for a PR's convergence loop, `delivery-graph/<hash>`, … The floor's description
  is the PR's status and round (or the escalation's subject), prefixed with `⚠️ incident` when the engine has one.
  Floors open as processes start and close when they finish (their workers go back to the bench first).
- **Desks are the process's agent steps**: service tasks whose job type is `pool:capability` (e.g.
  `senior:pr-review`), in BPMN order. A worker sits at the desk of the step whose job it holds (engine
  `/v2/jobs/search`, state CREATED, by `worker`); call activities count on their root's floor.
- **Whiteboard**: the floor's PR, its escalations (🚨), user tasks (🙋), events and timers it waits on (⏳), and
  agent steps no worker has picked up yet (🕒).
- **Phone**: `status`, `answer <id> …`, and `start owner/repo#123 [on <base>]` to hand nano-workforce an issue.
  Stickies can't be handed out: in this mode they're what nano-workforce is waiting on.
- The engine is the app's host on :8080 unless `--nano-engine <url>` / `CUBEFARM_NANO_ENGINE_URL` says otherwise
  (`CUBEFARM_NANO_ENGINE_AUTH`: an Authorization header value). GitHub isn't used at all in this mode.

## Whiteboards

In nano mode the kanban is replaced:

- **Process floors** show the instance's BPMN diagram (from the model's own diagram coordinates), live:
  green = a worker holds the step (👷 name), amber = an agent step queued with no worker yet, red = an escalation
  waiting on you, orange = a human step, blue = waiting for an event/timer, grey = done before, faint = not reached.
  `×n` is how many times a step completed (convergence rounds), ⚠ marks an incident, and flows already taken are solid.
- **The bench (floor 1)** shows the fleet: every agent job type with who holds one (and on which floor, for how long)
  and how many are queued, the processes running and where each is, idle and offline workers, and open escalations.

Click a board for a larger view. Data: engine `/v2/element-instances` (all states) per root instance, built in
`server/nano/floors.ts` (`processBoard`, `fleetBoard`) and drawn by `client/src/world/nanoDraw.ts`.
