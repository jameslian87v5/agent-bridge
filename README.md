# Agent Bridge

Agent Bridge is a lightweight local file bridge for coordinating CLI agents.

This repo is the standalone extraction of the working bridge used in
`simple-chatapp`. The protocol is intentionally unchanged: queue, inflight,
review, ack, done, and logs are plain files on disk.

The tool should be installed once, while runtime data stays in each project.
There is no database and no hosted service.

## Directory Layout

The tool code lives here:

```text
agent-bridge repo/
  bridge.mjs
  bridge-watch.mjs
  bridge-console.mjs
  lib/config.mjs
```

Runtime files live inside the target project:

```text
<project>/.agent-bridge/workspaces/<workspace-id>/
  queue/
  inflight/
  reviews/
  acks/
  artifacts/
  done/
  logs/
  control.json
```

Example project workspace config:

```json
{
  "id": "simple-chatapp",
  "projectRoot": ".",
  "bridgeDir": ".agent-bridge/workspaces/<workspace-id>"
}
```

Because paths are relative, run commands from the project root or pass
`--config`, `--project-root`, and `--bridge-dir`.

## Protocol

The bridge has four important concepts:

```text
queue     = work another agent must handle
reviews   = result/status written by the receiving agent
acks      = marker that the receiving agent handled the event
artifacts = long Markdown context for non-trivial requests
```

Rule:

```text
review does not create new work.
queue creates new work.
```

If an agent needs clarification or follow-up work from the other agent, it should create a new `queue/*.json` event with `replyTo` and `threadId`.

## Current Commands

Use the existing scripts directly during extraction:

```bash
node /Users/jameslian/Work/projects/agent-bridge/bridge.mjs status
node /Users/jameslian/Work/projects/agent-bridge/bridge-console.mjs
node /Users/jameslian/Work/projects/agent-bridge/bridge-watch.mjs --agent codex
```

Or use package bin names after linking/installing:

```bash
agent-bridge status
agent-bridge-console
agent-bridge-watch --agent codex
agent-bridge-watch-all
```

## First-Time Setup In A Project

From project root:

```bash
cd /path/to/project
node /Users/jameslian/Work/projects/agent-bridge/bridge.mjs \
  --bridge-dir .agent-bridge/workspaces/$(basename "$PWD") \
  init
```

Check status:

```bash
agent-bridge status
```

## Start Agents In tmux

Create one tmux session for each logical agent:

```bash
tmux new -s codex
```

Inside that tmux session, start Codex from the project root:

```bash
cd /path/to/project
codex
```

In another terminal:

```bash
tmux new -s claude
```

Inside that tmux session, start Claude Code from the project root:

```bash
cd /path/to/project
claude
```

If your Claude Code command is different, use your actual CLI command. The important part is that the tmux session name matches the bridge target below.

## Configure Agent Targets

Tell the bridge where to inject work:

```bash
node /Users/jameslian/Work/projects/agent-bridge/bridge.mjs target --agent codex --target tmux:codex
node /Users/jameslian/Work/projects/agent-bridge/bridge.mjs target --agent claude-code --target tmux:claude
```

Check:

```bash
agent-bridge status
```

Expected target line:

```text
agents=codex=tmux:codex, claude-code=tmux:claude
```

## Start Watchers

Start all configured watchers:

```bash
agent-bridge-watch-all
```

Or start one watcher per logical receiving agent manually.

Terminal 1:

```bash
cd /path/to/project
node /Users/jameslian/Work/projects/agent-bridge/bridge-watch.mjs --agent codex
```

Terminal 2:

```bash
cd /path/to/project
node /Users/jameslian/Work/projects/agent-bridge/bridge-watch.mjs --agent claude-code
```

Each watcher only handles events where `to` matches its agent name. Future
standalone work will make `watch-all` restart failed children and expose their
state in the console.

## Open The Console

In another terminal:

```bash
cd /path/to/project
agent-bridge-console
```

Open:

```text
http://127.0.0.1:4088
```

The console shows:

- queue events grouped by receiving agent
- inflight events
- done events
- reviews
- acks
- watcher logs
- recent Codex sessions

In manual mode, events need `Approve` before a watcher injects them into tmux.
`review_ready` notifications are auto-approved by default because they only tell
the receiver to read an existing review file. Normal work events still require
manual approval unless mode is set to `auto`.

## Send Work From Codex To Claude Code

Simple inline request:

```bash
agent-bridge send \
  --from codex \
  --to claude-code \
  --action review \
  --subject "Review current migration direction" \
  --body "Please inspect the current diff and return findings."
```

Then open the console and approve the event under:

```text
Queue To claude-code
```

The `claude-code` watcher moves it to `inflight/` and injects the request into `tmux:claude`.

## Send Work From Claude Code To Codex

```bash
agent-bridge send \
  --from claude-code \
  --to codex \
  --action review \
  --subject "Review Claude Code changes" \
  --body "Please inspect the latest implementation and return findings."
```

Approve the event under:

```text
Queue To codex
```

The `codex` watcher injects it into `tmux:codex`.

## Request An Isolated Worktree

For implementation tasks where the receiver should avoid touching the main
working tree, add `--worktree` when sending the event:

```bash
agent-bridge send \
  --from codex \
  --to claude-code \
  --action implement \
  --subject "Implement isolated fix" \
  --body "Make the change in an isolated worktree." \
  --worktree \
  --worktree-name "evt_fix_round_1" \
  --worktree-base HEAD
```

This does not create the worktree automatically. It writes this metadata into
the event:

```json
{
  "worktree": {
    "required": true,
    "name": "evt_fix_round_1",
    "base": "HEAD",
    "branch": "bridge/evt_fix_round_1",
    "path": ".agent-bridge/worktrees/evt_fix_round_1"
  }
}
```

If the task needs code edits, the receiving agent creates it before editing:

```bash
git worktree add -b bridge/evt_fix_round_1 .agent-bridge/worktrees/evt_fix_round_1 HEAD
cd .agent-bridge/worktrees/evt_fix_round_1
```

Review and ack files still go back to the original absolute bridge paths from
the injected prompt.

## Review Ready Notifications

When a receiving agent writes `reviews/<event_id>.review.md` and
`acks/<event_id>.json`, the bridge may create a notification event back to the
original sender:

```json
{
  "id": "evt_review_ready_evt_original",
  "from": "codex",
  "to": "claude-code",
  "type": "review_ready",
  "requestedAction": "read_review",
  "summary": "Review ready: evt_original",
  "replyTo": "evt_original",
  "threadId": "mp4c-diagnostics",
  "body": "Codex has written the review. Read reviewFile and continue only if action is needed.",
  "reviewFile": ".agent-bridge/workspaces/<workspace-id>/reviews/evt_original.review.md",
  "ackFile": ".agent-bridge/workspaces/<workspace-id>/acks/evt_original.json",
  "createdAt": "2026-07-04T11:20:00.000Z"
}
```

`review_ready` events are notifications, not new implementation work. They
should not request or create a worktree by default. After a `review_ready` event
is acked, the bridge must not create another `review_ready` for it; otherwise
notifications can loop.

## Use Markdown For Non-Trivial Requests

For anything more than a small request, write detailed context to `artifacts/` first:

```bash
mkdir -p .agent-bridge/workspaces/<workspace-id>/artifacts
```

Create:

```text
.agent-bridge/workspaces/<workspace-id>/artifacts/evt_auth_review.request.md
```

Recommended sections:

```md
# Context

# Request

# Constraints

# Relevant Files

# Expected Output
```

Then send:

```bash
agent-bridge send \
  --from codex \
  --to claude-code \
  --action review \
  --subject "Review auth implementation" \
  --body-file ".agent-bridge/workspaces/<workspace-id>/artifacts/evt_auth_review.request.md" \
  --thread-id "auth-review"
```

## What The Receiving Agent Must Write

When an agent receives an inflight event, it should write both files:

```text
.agent-bridge/workspaces/<workspace-id>/reviews/<event_id>.review.md
.agent-bridge/workspaces/<workspace-id>/acks/<event_id>.json
```

Example ack:

```json
{
  "id": "evt_20260621123000",
  "status": "handled",
  "createdAt": "2026-06-21T12:30:00.000Z"
}
```

After the ack exists, the watcher moves the event from `inflight/` to `done/`.

## Clarification Flow

If the receiving agent needs more information, it should not only ask inside `reviews/`.

It should create a new queue event:

```json
{
  "id": "evt_002",
  "from": "claude-code",
  "to": "codex",
  "type": "manual",
  "requestedAction": "answer",
  "summary": "Need clarification before continuing",
  "replyTo": "evt_001",
  "threadId": "auth-review",
  "body": "Should this auth flow support multi-tenant RBAC in the first pass?",
  "createdAt": "2026-06-21T12:35:00.000Z"
}
```

Meaning:

```text
ack JSON = current task handled or blocked
queue JSON = new work for the other agent
review MD = result/status for the current task
```

## Useful Commands

Status:

```bash
agent-bridge status
```

Pause injection:

```bash
agent-bridge pause
```

Resume injection:

```bash
agent-bridge resume
```

Auto-inject approved target queues without manual approval:

```bash
agent-bridge mode auto
```

Manual approval mode:

```bash
agent-bridge mode manual
```

Reject a queued event:

```bash
agent-bridge reject <event_id>
```

Write a test ack:

```bash
agent-bridge ack <event_id>
```

## Common Problems

### `npm run dev` says missing script

You are probably in the old or wrong directory. Check:

```bash
pwd
ls -la
cat package.json
```

For this project, use:

```bash
cd /path/to/project
```

### Console starts but queue does not inject

Check:

```bash
agent-bridge status
```

Make sure:

- `paused=false`
- target is correct, for example `claude-code=tmux:claude`
- the receiving watcher is running
- the event is approved in manual mode

### tmux injection fails

List sessions:

```bash
tmux ls
```

If your session is named differently, update target:

```bash
agent-bridge target --agent claude-code --target tmux:<your-session-name>
```

### Event appears under the wrong queue

Check the event JSON:

```bash
cat .agent-bridge/workspaces/<workspace-id>/queue/<event_id>.json
```

The `to` field controls which watcher handles it:

```json
{
  "to": "claude-code"
}
```

## Minimal Daily Workflow

1. Start `tmux:codex` and `tmux:claude`.
2. Start both watchers.
3. Start the console.
4. Send a queue event from one agent to the other.
5. Approve it in the console.
6. Receiving agent writes review + ack.
7. Repeat with `replyTo` and `threadId` for ongoing discussion.
