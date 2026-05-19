# Changelog

## 1.2.1

Schema-coverage patch. Long write-tasks under 1.2.0 (56s+ runs that edit
files and execute commands) exposed three codex 0.131 notification methods
that `normalizeNotification` did not recognise. The events stream stayed
correct — raw payloads were preserved untouched, so consumers could still
read everything from `raw.delta` / `raw.diff` / `raw.plan` — but the
normalised `phase` defaulted to `unknown`, hiding useful signal from
main-loop Claude. This release maps each of them to a real phase and
adds a useful `message` summary while keeping the raw shape intact.

- **`turn/plan/updated` → `phase: "thinking"`**: codex emits this when
  its internal plan/todo list mutates. Wire shape:
  `{ threadId, turnId, explanation: string|null, plan: [{ step, status }] }`
  where status ∈ `{completed, inProgress, pending, ...}`. The normalised
  message reports `Plan updated (N steps: X done, Y in progress, Z pending)`
  so the events stream is self-describing without consulting `raw`.
- **`turn/diff/updated` → `phase: "editing"`**: codex streams the running
  unified-diff while editing files (a precursor to the final `fileChange`
  item). Wire shape: `{ threadId, turnId, diff: string }`. The normalised
  message counts unified-diff file headers (`diff --git`) and reports
  `Diff updated (N files)`. `raw.diff` is preserved verbatim for patch
  rendering.
- **`item/commandExecution/outputDelta` → `phase: "running"`**: codex
  streams stdout chunks while a `commandExecution` item is still running.
  Wire shape: `{ threadId, turnId, itemId, delta: string, stream: null }`
  (the 0.131 build has not started distinguishing stdout vs stderr — all
  observed `stream` values are `null`). The normalised event is tagged
  `itemType: "commandExecution"`, `lifecycle: "delta"`, and reports
  `Command output +N bytes`. Full `delta` is preserved in `raw` so
  consumers can join chunks in `seq` order to reconstruct full stdout.
- **`turnId` fallback**: all three normalisers prefer `params.turnId`
  but fall back to `state.threadTurnIds.get(threadId)` for forward-compat
  with future codex builds that may omit `turnId` from these specific
  notifications.
- **Coverage**: `normalizeNotification` now recognises every distinct
  method observed in real codex 0.131 traces from the 1.2.0 push-mode
  E2E runs.

Tests: 7 new cases in `tests/normalize-notification.test.mjs` covering
each new method (happy path + fallback path), wire-observed payloads
copied verbatim from a real 56s task trace. 156/156 pass.

## 1.2.0

Push-mode delivery for the main Claude loop. 1.1.x exposed the per-job
event stream as a pull contract (`/codex:events <id> --since N`). 1.2.0
adds a push contract for sessions where the main loop wants real-time
notification of each codex notification without a poll loop.

- **`/codex:stream <prompt>`** (new): runs codex in foreground push mode.
  Each notification is written as one NDJSON line to stdout in the form
  `{"jobId":"task-...","seq":N,"ts":"...","method":"...","phase":"...",
  "message":"..."}`. Designed for the main Claude loop to wrap with
  `Monitor({command: "node ... task-stream ..."})` — each NDJSON line
  becomes a push notification, stream ends on `{type:"job/exited"}`.
- **`task-stream` subcommand** in codex-companion: foreground execution
  that shares the `runTrackedJob` + `executeTaskRun` + `appendJobEvent`
  pipeline with the existing background path. Events are still persisted
  to `{stateDir}/jobs/{jobId}.events.ndjson`, so `/codex:events <id>` and
  `/codex:result <id>` keep working after the stream ends or a consumer
  reconnects from another Claude Code session.
- **Equivalent disk contract**: `/codex:stream` and
  `/codex:rescue` + `/codex:events` produce the same `events.ndjson`
  bytes. Pick by delivery ergonomics (push vs pull), not by capability.
- Stall watchdog and `{type:"job/exited"}` terminal-event semantics
  identical to the background path.

Tests: new `tests/task-stream.test.mjs` integration test spawns
`task-stream` against fake codex, asserts each stdout line is valid
NDJSON with monotonic `seq`, the same `jobId` across all lines, and a
terminal `job/exited` record matching `events.ndjson` on disk.
149/149 pass.

## 1.1.1

Follow-up to 1.1.0 closing gaps identified during post-merge verification.

- **Criterion #4 finally landed end-to-end**: 1.1.0 promised
  `token usage in /codex:status output + events stream` but only the
  events stream half worked. The verification round found three gaps:
  `runAppServerTurn` returned `usage: turnState.finalTurn?.usage` but
  codex 0.131 doesn't put usage on the turn payload — only in
  `thread/tokenUsage/updated` notifications. `executeTaskRun` dropped
  `usage` from the stored job payload. And `renderJobStatusReport`
  had no Tokens line. All three fixed:
  - `captureTurn` state now accumulates `tokenUsage` from
    notifications. `applyTurnNotification` handles
    `thread/tokenUsage/updated` and stores `params.usage ??
    params.tokenUsage ?? params` as the latest value (codex emits
    cumulative totals, so each update replaces the previous).
  - `runAppServerTurn.usage` now returns the accumulator and falls
    back to `finalTurn?.usage` for forward-compat with future codex
    versions.
  - `executeTaskRun` includes `usage` in the persisted payload.
  - `renderJobStatusReport` shows `Tokens: in=N out=N [cached=N]`
    when usage is present. Field-name probing walks
    `usage.total → usage.last → usage` then `.inputTokens / .input`,
    `.outputTokens / .output`, `.cachedInputTokens / .cached /
    .cachedTokens`. Real codex 0.131 nests counts under
    `{ tokenUsage: { total: {...}, last: {...},
    modelContextWindow: N } }` (discovered via E2E spike).

- **Stall watchdog gains regression coverage**: 1.1.0 verified the
  watchdog manually (stallMs=8540 in a real codex run). 1.1.1 adds an
  integration test in `tests/stuck-watchdog.test.mjs` that spawns a
  background task against a fake codex configured to hang after
  `turn/start` (new fake-codex behavior
  `hang-after-turn-start`), waits for the worker's setInterval to
  detect the silence, and asserts the events stream contains
  `{type:"watchdog", phase:"stuck"}` with `stallMs >= threshold`.
  Test runs ~6 seconds, stable across consecutive runs.

- **`CODEX_EVENTS_RAW=0` to disable raw payloads**: long sessions can
  grow the events.ndjson file quickly because the `raw` field carries
  full notification payloads. Setting this env var strips `raw` at
  the `appendJobEvent` layer (state-layer policy; `normalizeNotification`
  itself remains a pure transform that always produces `raw`).
  Default behavior unchanged.

- **`thread/compact/start` schema confirmed**: codex 0.131 returns
  `{}` (empty object) on successful compaction — compaction is fully
  async and status updates flow via subsequent notifications. The
  wrapper continues to preserve `result` verbatim for forward-compat.

## 1.1.0

Observability rework for the main-loop orchestration case: the consumer of
"what is codex doing right now" is the calling Claude session, not a human
dashboard. Adds a per-job NDJSON event stream the main loop can poll, plus
a protocol-native recovery path for context overflow.

- `/codex:events <job-id>`: new slash command. Streams normalized codex
  notifications from `{stateDir}/jobs/{jobId}.events.ndjson`. Supports
  `--since <iso>` / `--after-seq <n>` / `--limit <n>` / `--json` for
  incremental polling. Each event carries `seq`, `ts`, `method`, `phase`,
  `itemType`, `message`, and the raw payload.
- `/codex:compact <thread-id>`: new slash command wrapping codex
  app-server's `thread/compact/start`. Protocol-native recovery for
  "prompt too long" — typical flow is cancel → compact → resume with an
  amended prompt via `/codex:rescue --resume`.
- `/codex:rescue` now defaults to `--background`. The main Claude loop
  receives a job id immediately and polls `/codex:events` instead of
  blocking on a synchronous Bash call; this removes the deadlock when
  codex stalls or errors silently.
- Per-job stall watchdog (60s default, override via
  `CODEX_COMPANION_STALL_SECONDS`) emits a `{type:"watchdog",
  phase:"stuck"}` event when codex produces no new notifications inside
  the window. The watchdog never cancels — the main loop decides whether
  to continue, compact, or cancel.
- New `{type:"job/exited"}` terminal event with `phase: completed|failed`
  and `exitCode`. This is the single source of truth for end-of-job;
  callers should not infer terminal state from job-level `status` alone.
- Surfaces token usage as a top-level field on `runAppServerTurn` and
  streams real-time usage via `thread/tokenUsage/updated` events
  (`phase: "metering"`).
- Coverage of codex CLI 0.131 notification methods extended to
  `thread/status/changed`, `warning`, `thread/tokenUsage/updated`, plus
  item types `userMessage`, `assistantMessage`/`agentMessage`, and
  `reasoning`. The `agentMessage` item now surfaces a content preview so
  the main loop can recognize codex's final reply from the event stream
  without fetching `/codex:result`.
- Test isolation: `tests/helpers.mjs` now unsets `CLAUDE_PLUGIN_DATA` and
  `CODEX_COMPANION_SESSION_ID` at module load. Plugin host runtimes (e.g.
  Claude Code) inject these vars; without isolation, two existing tests
  fail when contributors run `npm test` from inside a host.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
