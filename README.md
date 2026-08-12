# Agent Bridge — Real Agent Loop Engineering

[中文说明](./README.zh-CN.md)

A local, file-based bridge that lets multiple CLI agents (Codex, Claude Code, OpenCode…) send work to each other through tmux terminals.

No database, no cloud, no central server. Just JSON files, tmux, and a small web console.

```text
agent-bridge/                        # this repo: the tool, installed once
/path/to/your-project/.agent-bridge/ # each project: its own runtime data
```

## How It Works (60 seconds)

```text
Agent A                          Agent B
  │                                │
  ├─ send queue event ──────────▶  │ watcher injects into B's tmux
  │                                ├─ B reads event, does the work
  │                                ├─ B writes review + ack
  │  ◀── review_ready (auto) ──────┤ watcher notifies A
  ├─ A reads review, acks          │
  │                                │
  │  more work? send a NEW event ─▶│ (never reply review-to-review)
```

The whole state lives in directories you can inspect:

```text
queue/      events waiting for an agent
inflight/   events injected, waiting for ack
reviews/    review markdown written by the receiver
acks/       JSON marker that closes the event
done/       finished events
failed/     events that could not be delivered
artifacts/  long-form request context
logs/       watcher logs
```

Three rules:

- **queue creates work** — if another agent must act, send a new queue event
- **review records results** — reviews never trigger more reviews
- **ack closes the event** — watcher moves inflight → done

## Install

Requires **Node.js 18+** and **tmux**.

tmux is pre-installed on macOS and most Linux distros. On Windows, install it via
[WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) (`sudo apt install tmux`),
[MSYS2](https://www.msys2.org/) (`pacman -S tmux`), or [Cygwin](https://www.cygwin.com/).

From this repo:

```bash
cd /path/to/agent-bridge
npm link
```

Now `agent-bridge`, `agent-bridge-console`, `agent-bridge-watch`, and
`agent-bridge-watch-all` work from any project. Or skip `npm link` and call the
scripts directly:

```bash
node /path/to/agent-bridge/bridge.mjs status
```

## Set Up A Project

Shortest path:

```bash
cd /path/to/your-project
agent-bridge setup --link-agent-docs --include-windsurf
agent-bridge start
```

`setup` (interactive or with flags) does:

- creates `agent-bridge.workspace.json` and `.agent-bridge/workspaces/<project-id>/`
- installs `.agent-bridge/AGENT_BRIDGE.md` — the rules every agent reads
- links those rules into `AGENTS.md` / `CLAUDE.md` / Windsurf rules
  (marker block `agent-bridge:start` … `agent-bridge:end`, safe to re-run)
- writes agent → tmux target mappings into `control.json`
- registers the project in `~/.agent-bridge/projects.json`

One-shot, non-interactive:

```bash
agent-bridge --project /path/to/your-project setup \
  --agent codex-1=tmux:codex-1 \
  --agent claude-1=tmux:claude-1 \
  --port auto --link-agent-docs --include-windsurf
```

Project registry commands:

```bash
agent-bridge projects            # list registered projects
agent-bridge projects --status   # + run state and console URLs
agent-bridge project remove <id> # unregister
```

## Prepare Agent Terminals

One tmux session per logical agent. The session name must match the target in
`control.json` exactly — including spelling:

```bash
tmux new -s codex-1      # inside: cd your-project && codex
tmux new -s claude-1     # inside: cd your-project && claude
```

If injection fails with `tmux session not found`, run `tmux ls` and compare the
names with `agent-bridge status` output. Rename the tmux session or update the
binding:

```bash
agent-bridge target --agent codex-1 --target tmux:codex-1
```

## Run It

```bash
agent-bridge start            # console + watchers in background
agent-bridge status --run     # check processes
agent-bridge restart          # stop + start (see below)
agent-bridge stop
```

`restart` does three things:

1. stops watchers and console
2. **re-renders the rule files** (`AGENT_BRIDGE.md`, `AGENTS.md`, `CLAUDE.md`)
   from the latest `control.json` — role and principles edits apply here
3. starts everything again; inflight events get a fresh timeout window instead
   of being re-injected immediately

All commands also work from anywhere with a project id:
`agent-bridge restart <project-id>`.

Pid files live in `~/.agent-bridge/runs/`, logs in `~/.agent-bridge/logs/<id>/`.

## Send Work

```bash
agent-bridge send \
  --from codex-1 --to claude-1 \
  --subject "Review current diff" \
  --body "Please inspect the diff and write review + ack."
```

For long requests, write a markdown file first and use `--body-file`. For work
that continues a thread, add `--reply-to <event-id> --thread-id <name>` so the
hop budget is inherited. For isolated code edits, add `--worktree` (details in
`AGENT_BRIDGE.md`).

## Modes: Manual vs Auto

```bash
agent-bridge mode manual   # default: every event needs an approve
agent-bridge mode auto     # events inject immediately
agent-bridge approve <event_id>
agent-bridge reject <event_id>
agent-bridge pause / resume
```

`review_ready` notifications are auto-approved in both modes (they only ask the
sender to read an existing review).

### Loop Budget (auto mode)

Auto mode could ping-pong forever, so every event carries an `autoHops` counter
per agent:

```json
{ "replyTo": "evt_1", "autoHops": { "codex-1": 4, "claude-1": 3 } }
```

- the counter increments each time that agent's watcher injects the event
- `--reply-to` and `review_ready` events inherit the counter
- at `maxAutoHopsPerAgent` (default **10**) the watcher stops auto-injecting
  and leaves the event in `queue/`
- `agent-bridge approve <event_id>` overrides the budget
- `send` without `--reply-to` starts a fresh chain
- timeout retries do not consume budget

## Stability: Timeouts, Retries, Failed

Every injected event records `injectedAt` and `retryCount`:

- **timeout** (`inflightTimeoutMs`, default **5 min**) without an ack →
  re-inject with `retryCount + 1`
- **already has a review** → close it to `done/`
- **tmux session dead** or **retries exhausted** (`maxRetries`, default **2**) →
  move to `failed/`
- `maxInflight` (default 1) limits how many events an agent processes at once

Events in `failed/` are visible in the console. To retry one, move the JSON
back to `queue/` (or resend).

## Console

Started by `agent-bridge start`, or manually:

```bash
agent-bridge-console --port 4088   # open http://127.0.0.1:4088
```

One console per project; ports auto-allocate from 4088.

The console shows queue/inflight/failed/done/reviews/logs and lets you edit
`control.json` directly:

- **Agent Targets And Injection Templates** — tmux target, injection template,
  and `role` per agent (injected into templates as `{{role}}`)
- **Stability And Loop Budget** — `maxInflight`, `inflightTimeoutMs`,
  `maxRetries`, `maxAutoHopsPerAgent`, `verifyInject`

Watchers re-read `control.json` on every poll — settings apply without restart.
**Exception:** role and principles edits only reach `AGENT_BRIDGE.md` /
`AGENTS.md` / `CLAUDE.md` after `agent-bridge restart`.

## Injection Templates

Each agent gets its instructions from a template with placeholders:

```text
Bridge event {{id}} is ready.

You are {{agentName}} in the bridge receiver role.{{role}}
Read {{eventPath}}.
...
```

There is **one built-in default template** — no per-agent setup needed. A
template saved for a specific agent in the console overrides the default.
`{{agentName}}` and `{{role}}` are filled from `control.json` automatically.

New projects start with **zero configured agents** — `defaultControl` no longer
pre-creates `codex`/`claude-code`. Agents only exist if you add them (setup,
`target` command, or console).

## Receiver Contract

An agent that receives an event must write both files:

```text
acks/<event_id>.json        # write FIRST — prevents timeout re-injection
reviews/<event_id>.review.md # write when work is complete
```

Write **ack immediately** to acknowledge receipt. This stops the 5-minute
timeout from re-injecting the event. Write **review when the work is done** —
the watcher will send a `review_ready` back to the sender once it appears.

Minimal ack:

```json
{ "id": "evt_20260705120000", "status": "handled", "createdAt": "..." }
```

Ack present → watcher moves the event to `done/`. Review also present → watcher
sends a `review_ready` back to the original sender. The full collaboration
rules (lifecycle, follow-up via `send`, anti-ping-pong) are in the generated
`.agent-bridge/AGENT_BRIDGE.md`.

## Troubleshooting

- **Event stuck in queue** — check `agent-bridge status`: `to` matches a
  configured agent, watcher running, event approved (manual mode)
- **`tmux session not found`** — `tmux ls`, compare spelling with the target,
  rename session or re-bind with `agent-bridge target`
- **Event stuck in inflight** — it will time out and retry; after
  `maxRetries` it lands in `failed/`
- **Console shows stale UI** — the console does not hot reload;
  `agent-bridge restart`
- **Changed roles/principles but agents don't see them** — rule files are only
  re-rendered on `restart` or `install-rules --force --link-agent-docs`
- **Watcher swallowed keys / agent in copy-mode** — the watcher exits tmux
  copy-mode before injecting; if you scrolled in a pane, press `q` or `Esc`

## Layout

```text
This repo (versioned tool):
  bridge.mjs            CLI
  bridge-watch.mjs      per-agent watcher
  bridge-watch-all.mjs  starts one watcher per configured agent
  bridge-console.mjs    web console
  lib/config.mjs        defaults, control.json handling
  templates/AGENT_BRIDGE.md  agent rules template

Your project (runtime data only):
  agent-bridge.workspace.json
  .agent-bridge/
```

Do not copy tool source into projects.
