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

## Event Lifecycle

```text
Agent A                          Agent B
  │                                │
  ├─ send queue event ──────────▶  │
  │                                ├─ read event
  │                                ├─ do work
  │                                ├─ write review
  │                                ├─ write ack
  │  ◀── review_ready (auto) ──────┤
  ├─ read review                   │
  ├─ ack review_ready              │
  │                                │
  │  if more work needed:          │
  ├─ send NEW queue event ──────▶  │
  │    (replyTo + threadId)        │
  │                                │
```

## Receiver Contract

When you receive a bridge event:

1. Read the event JSON.
2. Read `bodyFile` or referenced artifacts if present.
3. Inspect referenced files and the current git diff if relevant.
4. Write ack first to acknowledge receipt and prevent timeout re-injection:
   - `acks/<event_id>.json`
5. Do the work, then write review when complete:
   - `reviews/<event_id>.review.md`
6. Do not only answer in chat.

Keep reviews concise and actionable.
For long tasks, write ack immediately so the watcher does not re-inject
the event after the 5-minute timeout. The review can follow later — the
watcher will send a `review_ready` notification once it appears.

## Thread Awareness

Events may carry a `threadId`. If present, a thread state file exists at
`threads/<threadId>.json` with the thread type and status:

- **`plan-execution`** — multi-stage task with a plan. Follow stages in order, do not skip ahead. Use `--type plan-execution` when starting the thread.
- **`discussion`** — open-ended discussion. Iterate until convergence, then mark thread done.
- **`review`** — single-round review. Complete and close.
- **`ad-hoc`** — one-off task, no thread state needed.

When you receive an event with a threadId, read `threads/<threadId>.json` to
understand where this thread stands. In your review, state whether the current
stage passed or failed. If you need to continue the thread, send a new event
with the same `--thread-id`.

## Follow-Up Work (Creating New Events)

If the other agent needs to act after your review, **do not** just mention it
in the review text. Explicitly create a new event:

```bash
node agent-bridge/bridge.mjs send \
  --to <target-agent> \
  --reply-to <original-event-id> \
  --thread-id <thread-id> \
  --type <plan-execution|discussion|review|ad-hoc> \
  --subject "what needs to be done" \
  --body "detailed instructions"
```

This puts the event in the target agent's `queue/` directory. The watcher
will inject it into their terminal.

## Review Cycle (One-Shot)

The review cycle is **one-shot**: receiver writes review → watcher auto-notifies
sender via `review_ready` event → sender reads review → **must act**.

`review_ready` events do **not** trigger another `review_ready`. The cycle stops
after one round. After reading the review, you **must** take one of these actions:

1. **Issues found** → send a NEW `queue` event with `--reply-to` and `--thread-id`
   describing what to fix. Do not reply with another review.
2. **Review passes, thread complete** → update `threads/<threadId>.json` status
   to `"done"`. No new event needed.
3. **Review passes, next stage in plan** → send a NEW `queue` event for the next
   stage with the same `--thread-id` and `--type plan-execution`.

**Never silently ignore a review_ready event.** Always ack it, read the review,
and take one of the above actions.

## Anti-Ping-Pong Rules

- Each event is one round of work. Do not reply to a review with another
  review. Send a new event instead.
- In `auto` mode, each agent has a hop budget (`maxAutoHopsPerAgent`, default
  10). When exhausted, events stop auto-injecting and wait for manual approval.
- If you see the same thread bouncing back and forth, pause and escalate to
  the human instead of continuing the loop.

## Shared Principles

<!-- agent-bridge:principles -->
All agents in this project follow these principles:

- 系统思维：把改动放回整个系统看，不只看当前任务。改一处要问清楚谁受影响、上下游是否一致。项目级决策要考虑部署顺序、迁移路径、回滚方案。
- 架构思维：先想清楚边界、职责和数据流，再动手。新增东西先问"该放哪一层"，而不是"放哪最快"。跨模块协作时显式声明契约，不靠隐式约定。
- 第一性原理：复杂问题先问最底层事实和真正要保证的不变量，不按既有做法类比修补。遇到问题先定位根因，不在症状层打补丁。
- 对抗式审查：完成后主动找破口，证明哪里会坏，不是复述方案为什么对。检查边界情况、权限越界、数据泄漏。上线前问"如果被滥用会怎样"。
- 奥卡姆剃刀：不过度工程化，能用一行解决就不写十行。不提前抽象、不为假想需求建框架。每个决策都要能回答"为什么需要它"。
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
