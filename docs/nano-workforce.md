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

Floors are still connected in the lobby: the office reads issues and PRs for the whiteboard from GitHub as usual.
Hire workers with `c8ctl nano hire` / `c8 nano workforce`: they take a desk when they connect.

| env | default | |
| --- | --- | --- |
| `CUBEFARM_NANO_URL` | | the app's origin or console-proxy URL (`/app/api` is added) |
| `CUBEFARM_NANO_SECRET` | `NANO_PR_WEBHOOK_SECRET` | sent as `x-hook-secret` |
| `CUBEFARM_NANO_POLL_MS` | 5000 | |
| `CUBEFARM_NANO_BASE_BRANCH` | the repo's default branch (sent with `confirmDefaultBase`) | e.g. `epic/issue-{n}` |

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
