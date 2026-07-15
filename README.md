# Agent Bridge

Agent Bridge is a local, file-based bridge for coordinating multiple CLI agents such as Codex, Claude Code, and Cascade.

It is designed to be installed once and used from many projects. The tool code lives in this repo; each project keeps its own bridge data under that project's `.agent-bridge/` directory.

There is no database, cloud service, or central queue.

```text
/Users/jameslian/Work/projects/agent-bridge/   # tool code
/path/to/your-project/.agent-bridge/           # that project's runtime data
```

## What It Does

Agent Bridge gives agents a shared local protocol:

```text
queue/      work waiting for an agent
inflight/   work already handed to an agent
reviews/    result or review markdown from the receiver
acks/       JSON marker that the event is handled
done/       completed or rejected event JSON
artifacts/  long request context
logs/       watcher logs
```

The important rule:

```text
queue creates work.
review records results.
ack closes the current event.
```

If a review asks another agent to continue, create a new queue event. Do not hide new work only inside a review file.

## Install For Local Use

From the Agent Bridge repo:

```bash
cd /Users/jameslian/Work/projects/agent-bridge
npm link
```

After this, these commands should be available from any project:

```bash
agent-bridge
agent-bridge-console
agent-bridge-watch
agent-bridge-watch-all
```

If you do not want to use `npm link`, run scripts directly:

```bash
node /Users/jameslian/Work/projects/agent-bridge/bridge.mjs status
node /Users/jameslian/Work/projects/agent-bridge/bridge-console.mjs
node /Users/jameslian/Work/projects/agent-bridge/bridge-watch-all.mjs
```

## Add Agent Bridge To A New Project

Shortest path:

```bash
cd /path/to/your-project
agent-bridge setup --link-agent-docs --include-windsurf
agent-bridge start
agent-bridge projects --status
```

`agent-bridge status --run` shows the current project's background processes.
`agent-bridge projects --status` shows every registered project's background
processes and console URL.

Detailed setup:

```bash
cd /path/to/your-project
```

Initialize bridge runtime and project config:

```bash
agent-bridge init
```

This creates:

```text
agent-bridge.workspace.json
.agent-bridge/workspaces/<project-id>/
```

By default, the project id is `basename-hash6`, for example
`backend-a1b2c3`. The hash comes from the absolute project path, so two
different directories with the same basename do not overwrite each other in the
global registry.

Install project-local agent instructions:

```bash
agent-bridge install-rules
```

This creates:

```text
.agent-bridge/AGENT_BRIDGE.md
```

To also link those rules from agent-specific instruction files, run:

```bash
agent-bridge install-rules --link-agent-docs --include-windsurf
```

This creates or updates:

```text
AGENTS.md
CLAUDE.md
.windsurf/rules/agent-bridge.md
```

If `.windsurfrules` already exists, it is updated too. The inserted block is
wrapped in `agent-bridge:start` / `agent-bridge:end` markers, so the command is
safe to run repeatedly.

Check the setup:

```bash
agent-bridge status
```

Or configure a project from anywhere with one command:

```bash
agent-bridge --project /path/to/your-project setup \
  --agent codex-1=tmux:codex-1 \
  --agent claude-main=tmux:claude-main \
  --agent cascade-1=tmux:cascade-1 \
  --port auto \
  --link-agent-docs \
  --include-windsurf
```

This does the same project setup steps:

- creates `/path/to/your-project/agent-bridge.workspace.json`
- creates `/path/to/your-project/.agent-bridge/workspaces/<project-id>/`
- installs `/path/to/your-project/.agent-bridge/AGENT_BRIDGE.md`
- optionally links the bridge rules into `AGENTS.md`, `CLAUDE.md`, and Windsurf rules
- writes the configured agent to tmux target mappings
- registers the project in `~/.agent-bridge/projects.json`
- assigns a console port, starting from 4088

You can also run an interactive setup wizard:

```bash
agent-bridge setup
```

It asks for:

```text
Project path, default current directory
Agent names
tmux target names
Console port, default auto
Whether to start watchers and console now
```

List registered projects:

```bash
agent-bridge projects
```

List registered projects with run state and console URLs:

```bash
agent-bridge projects --status
```

Remove a registered project:

```bash
agent-bridge project remove <project-id>
```

## Start Agent Terminals

Use one tmux session or pane per logical agent.

Example with Codex and Claude Code:

```bash
tmux new -s codex
```

Inside that tmux session:

```bash
cd /path/to/your-project
codex
```

Create another session:

```bash
tmux new -s claude
```

Inside it:

```bash
cd /path/to/your-project
claude
```

You can use more logical agents:

```text
codex-1
codex-reviewer
claude-main
claude-fixer
cascade-1
```

The logical agent name is the bridge route name. It does not have to equal the CLI product name.

## Bind Agents To tmux Targets

From the project root:

```bash
agent-bridge target --agent codex --target tmux:codex
agent-bridge target --agent claude-code --target tmux:claude
```

For multiple agents:

```bash
agent-bridge target --agent codex-reviewer --target tmux:codex-reviewer
agent-bridge target --agent claude-fixer --target tmux:claude-fixer
agent-bridge target --agent cascade-1 --target tmux:cascade
```

Check bindings:

```bash
agent-bridge status
```

You should see something like:

```text
agents=codex=tmux:codex, claude-code=tmux:claude
```

## Start Watchers

For registered projects, start the console and all watchers as background
processes from the project directory:

```bash
cd /path/to/your-project
agent-bridge start
agent-bridge status --run
agent-bridge stop
```

Use `status --run` for the current project. Use `projects --status` when you
want the overview for every registered project.

You can also control a project from anywhere by passing its project id:

```bash
agent-bridge start <project-id>
agent-bridge status <project-id>
agent-bridge stop <project-id>
```

`start` writes pid files under:

```text
~/.agent-bridge/runs/<project-id>.json
```

and logs under:

```text
~/.agent-bridge/logs/<project-id>/
```

For foreground debugging, start all configured watchers with one command:

```bash
agent-bridge-watch-all
```

A watcher handles events whose `to` field matches its agent name.

If you prefer manual control, start one watcher per receiving agent:

```bash
agent-bridge-watch --agent codex
agent-bridge-watch --agent claude-code
```

Rule of thumb:

```text
one logical receiving agent = one watcher
```

So if you configure `codex-1`, `codex-2`, and `claude-code`, `watch-all` starts watchers for all three.

## Open Console

From the project root:

```bash
agent-bridge-console
```

Open:

```text
http://127.0.0.1:4088
```

For multiple projects, run one console per project on a different port:

```bash
agent-bridge-console --project /path/to/project-a --port 4088
agent-bridge-console --project /path/to/project-b --port 4089
agent-bridge-console --project /path/to/project-c --port 4090
```

Then open:

```text
http://127.0.0.1:4088  # project-a
http://127.0.0.1:4089  # project-b
http://127.0.0.1:4090  # project-c
```

The console shows:

- queue grouped by receiving agent
- review-ready notifications
- inflight and done events
- review and ack files
- watcher logs
- configured agents and injection templates
- detected tmux targets

Use the console to approve normal work events. `review_ready` notifications are auto-approved by default because they only ask the receiver to read an existing review.

## Send Work To Another Agent

Send a review request from Codex to Claude Code:

```bash
agent-bridge send \
  --from codex \
  --to claude-code \
  --action review \
  --subject "Review current diff" \
  --body "Please inspect the current diff and write review + ack."
```

In manual mode:

1. Open console.
2. Find `Queue To claude-code`.
3. Click `Approve`.
4. The `claude-code` watcher injects the request into its tmux target.

Send work back from Claude Code to Codex:

```bash
agent-bridge send \
  --from claude-code \
  --to codex \
  --action review \
  --subject "Review implementation" \
  --body "Please review my changes and write review + ack."
```

## Use Artifact Files For Longer Requests

For non-trivial requests, write a Markdown artifact first:

```bash
mkdir -p .agent-bridge/workspaces/$(basename "$PWD")/artifacts
```

Create a request file:

```text
.agent-bridge/workspaces/<project-name>/artifacts/evt_feature_review.request.md
```

Then send:

```bash
agent-bridge send \
  --from codex \
  --to claude-code \
  --action review \
  --subject "Review feature plan" \
  --body-file ".agent-bridge/workspaces/<project-name>/artifacts/evt_feature_review.request.md" \
  --thread-id "feature-plan"
```

## Receiver Contract

When an agent receives an event, it must write both files before considering the event handled:

```text
.agent-bridge/workspaces/<project-name>/reviews/<event_id>.review.md
.agent-bridge/workspaces/<project-name>/acks/<event_id>.json
```

Minimal ack:

```json
{
  "id": "evt_20260705120000",
  "status": "handled",
  "createdAt": "2026-07-05T12:00:00.000Z"
}
```

After the ack exists, the watcher moves the event from `inflight/` to `done/`.

If a review file also exists, the watcher creates a `review_ready_<event_id>` notification back to the original sender.

## Worktree Requests

For isolated implementation work:

```bash
agent-bridge send \
  --from codex \
  --to claude-code \
  --action implement \
  --subject "Implement fix in worktree" \
  --body "Make this change in isolation." \
  --worktree \
  --worktree-name "fix-round-1" \
  --worktree-base HEAD
```

The event will include:

```json
{
  "worktree": {
    "required": true,
    "name": "fix-round-1",
    "base": "HEAD",
    "branch": "bridge/fix-round-1",
    "path": ".agent-bridge/worktrees/fix-round-1"
  }
}
```

The receiving agent creates and enters the worktree before editing code, but still writes review and ack files to the original bridge paths.

## Common Commands

```bash
agent-bridge status
agent-bridge pause
agent-bridge resume
agent-bridge mode manual
agent-bridge mode auto
agent-bridge approve <event_id>
agent-bridge reject <event_id>
agent-bridge ack <event_id>
```

Manual mode is recommended for normal work. Auto mode injects queued work without approval.

## Troubleshooting

### Console Does Not Show New UI

Restart the console process. The console is a Node process and does not hot reload.

```bash
agent-bridge-console
```

### Queue Event Does Not Inject

Check:

```bash
agent-bridge status
```

Then verify:

- the event `to` matches a configured agent name
- the target is correct, for example `claude-code=tmux:claude`
- `agent-bridge-watch-all` or the matching watcher is running
- in manual mode, the event is approved unless it is `review_ready`

### tmux Injection Fails

List tmux sessions:

```bash
tmux ls
```

Then update the binding:

```bash
agent-bridge target --agent claude-code --target tmux:<session-name>
```

The console also shows detected tmux targets that you can copy.

### Historical Events Did Not Create review_ready

Only watchers running the current code create `review_ready` notifications. If an old watcher handled the event before this feature existed, manually create a follow-up event or resend a queue notification.

## Versioning

This standalone repo is the versioned tool. Target projects should keep only runtime data and project-local rules:

```text
.agent-bridge/
agent-bridge.workspace.json
```

Do not copy tool source files into every project.
