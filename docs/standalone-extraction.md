# Standalone Extraction Plan

## Decision

Extract the working `simple-chatapp/agent-bridge` implementation into this
standalone repo. Do not design a new protocol first.

## Architecture

- Tool code lives in this repo.
- Runtime data remains project-local under `.agent-bridge/`.
- Existing queue, inflight, reviews, acks, done, logs, and control files stay
  compatible with the current bridge.
- Existing watcher and console behavior remain the baseline.

## First Milestone

- Copy the current bridge scripts as-is.
- Add package metadata and executable bin names.
- Add `bridge-watch-all.mjs` as a thin supervisor over existing watchers.
- Keep `simple-chatapp` unchanged except as a test host.

## Next Milestones

- Add `init` ergonomics for new projects.
- Improve console agent/template editing with an explicit agent list.
- Add tmux session/pane discovery and binding.
- Add auto-inject policy for `review_ready` notifications only.
- Add an `AGENT_BRIDGE.md` template for project-level agent rules.
