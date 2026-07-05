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

## Follow-Up Work

Do not hide new work only inside a review. If another agent must act, create a
new `queue/*.json` event with `replyTo` and `threadId`.

`review_ready` events are notifications. Read the referenced review file, then
create follow-up work only if action is needed.

## Worktrees

If an event has `worktree.required=true` and code edits are needed, create and
enter the requested git worktree before editing. Still write review and ack files
to the original bridge paths from the event prompt.
