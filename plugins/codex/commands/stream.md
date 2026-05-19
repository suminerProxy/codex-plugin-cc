---
description: Run a Codex task in foreground push mode — each notification is emitted as one NDJSON line to stdout (designed for the main Claude loop's Monitor tool)
argument-hint: '[--write] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]'
allowed-tools: Bash(node:*), Monitor
---

Run codex in foreground push mode. Each notification is written as one NDJSON line to stdout in the form `{"jobId":"task-...","seq":N,"ts":"...","method":"...","phase":"...","message":"..."}`. Wrapping this command with `Monitor({command: "..."})` turns every codex notification into a push notification for the main loop — no polling required.

Recommended invocation from the main Claude loop:

```
Monitor({command: "node \"${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs\" task-stream $ARGUMENTS"})
```

Stream ends when the worker emits `{"type":"job/exited"}` and the process exits. Monitor closes automatically.

Events are also persisted to `{stateDir}/jobs/{jobId}.events.ndjson`, so `/codex:events <job-id>` and `/codex:result <job-id>` continue to work after the stream ends or a consumer reconnects from another Claude Code session.

## When to use

- The main loop needs real-time awareness of codex's progress (each tool call, reasoning step, file change, token-usage update) and wants to react to phase transitions WITHOUT a polling loop.
- Long-running tasks where the main loop wants to detect `phase:"stuck"` / `phase:"warning"` / `phase:"metering"` as they happen instead of on the next poll.

## When NOT to use

- Fire-and-forget tasks where the main loop will check back later. Use `/codex:rescue` (background) + `/codex:events --since N` polling — that is the cross-session, durable contract.
- The main loop wants to interleave many short codex tasks in parallel. Monitor is single-stream; use rescue + events for many concurrent jobs.

## Equivalence guarantee

`/codex:stream <prompt>` and `/codex:rescue <prompt>` followed by repeated `/codex:events <id> --since N --json` produce the same `events.ndjson` contents on disk. The difference is delivery: stream pushes per-event over stdout; rescue+events polls a file. Pick by ergonomics, not capability.
