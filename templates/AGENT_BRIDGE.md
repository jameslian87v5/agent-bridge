# Agent Bridge Rules

Use Agent Bridge for cross-agent work in this project.

## Runtime Layout

Bridge files live under the project-local `.agent-bridge/` directory.

```text
queue/      pending events for an agent
inflight/   events already injected or being handled
reviews/    result or review markdown written by the receiver
acks/       JSON marker that an event is handled
done/       completed or rejected event JSON
artifacts/  long-form request context
logs/       watcher logs
```

## Receiver Contract

When you receive a bridge event:

1. Read the event JSON.
2. Read `bodyFile` or referenced artifacts if present.
3. Inspect referenced files and the current git diff if relevant.
4. Write both required files:
   - `reviews/<event_id>.review.md`
   - `acks/<event_id>.json`
5. Do not only answer in chat.

Keep reviews concise and actionable.

## Review Cycle (One-Shot)

The review cycle is **one-shot**: receiver writes review → watcher auto-notifies
sender via `review_ready` event → sender reads review → done.

`review_ready` events do **not** trigger another `review_ready`. The cycle stops
after one round. If you need further action, create a **new** `queue/*.json`
event with `replyTo` and `threadId`.

Do not hide new work inside a review. Explicitly queue a new event if another
agent must act.

## Shared Principles

<!-- agent-bridge:principles -->
All agents in this project follow these principles:

- Keep changes minimal and focused.
- Write reviews with concrete findings, not vague statements.
- Do not over-engineer.
<!-- agent-bridge:principles-end -->

## Agent Roles

<!-- agent-bridge:roles -->
Agent roles are configured during setup and stored in `control.json`.
Each agent has a `role` field describing its responsibility and boundaries.
<!-- agent-bridge:roles-end -->

## Worktrees

If an event has `worktree.required=true` and code edits are needed, create and
enter the requested git worktree before editing. Still write review and ack files
to the original bridge paths from the event prompt.

Use the event payload as the source of truth:

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

Typical flow:

```bash
git worktree add <worktree.path> -b <worktree.branch> <worktree.base>
cd <worktree.path>
```

Make code edits inside that worktree. Do not edit the main project tree for that
event unless the user explicitly says isolation is unnecessary.

When finished, write the required `reviews/<event_id>.review.md` and
`acks/<event_id>.json` files to the original bridge workspace paths shown in the
event prompt, not to a separate bridge directory inside the worktree.
