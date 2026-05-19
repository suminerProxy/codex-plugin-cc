import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { appendJobEvent } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

test("events command without job-id errors with usage", () => {
  const workspace = makeTempDir();
  const result = run("node", [SCRIPT, "events"], { cwd: workspace });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: events <job-id>/);
});

test("events command returns empty count for unknown job (--json)", () => {
  const workspace = makeTempDir();
  const result = run("node", [SCRIPT, "events", "ghost-job", "--json", "--cwd", workspace]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.jobId, "ghost-job");
  assert.equal(payload.count, 0);
  assert.deepEqual(payload.events, []);
});

test("events command returns appended events (--json)", () => {
  const workspace = makeTempDir();
  appendJobEvent(workspace, "task-int-1", {
    seq: 0,
    ts: "2026-01-01T00:00:00.000Z",
    phase: "starting",
    method: "thread/started",
    message: "Thread started (thr_x)."
  });
  appendJobEvent(workspace, "task-int-1", {
    seq: 1,
    ts: "2026-01-01T00:00:01.000Z",
    phase: "thinking",
    method: "turn/started",
    message: "Turn started (trn_y)."
  });

  const result = run("node", [SCRIPT, "events", "task-int-1", "--json", "--cwd", workspace]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.jobId, "task-int-1");
  assert.equal(payload.count, 2);
  assert.equal(payload.events[0].phase, "starting");
  assert.equal(payload.events[1].phase, "thinking");
});

test("events command --after-seq filters incrementally", () => {
  const workspace = makeTempDir();
  for (let i = 0; i < 4; i++) {
    appendJobEvent(workspace, "task-int-2", {
      seq: i,
      ts: `2026-01-01T00:00:0${i}.000Z`,
      phase: "p",
      message: `event ${i}`
    });
  }
  const result = run("node", [SCRIPT, "events", "task-int-2", "--after-seq", "1", "--json", "--cwd", workspace]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.count, 2);
  assert.deepEqual(
    payload.events.map((event) => event.seq),
    [2, 3]
  );
});

test("events command prints human-readable lines without --json", () => {
  const workspace = makeTempDir();
  appendJobEvent(workspace, "task-int-3", {
    seq: 0,
    ts: "2026-01-01T00:00:00.000Z",
    phase: "thinking",
    method: "turn/started",
    message: "Turn started (trn_z)."
  });
  const result = run("node", [SCRIPT, "events", "task-int-3", "--cwd", workspace]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /seq=0/);
  assert.match(result.stdout, /thinking/);
  assert.match(result.stdout, /Turn started/);
});

test("events command --limit caps event count", () => {
  const workspace = makeTempDir();
  for (let i = 0; i < 5; i++) {
    appendJobEvent(workspace, "task-int-4", {
      seq: i,
      ts: `2026-01-01T00:00:0${i}.000Z`,
      phase: "p"
    });
  }
  const result = run("node", [SCRIPT, "events", "task-int-4", "--limit", "2", "--json", "--cwd", workspace]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.count, 2);
  assert.deepEqual(
    payload.events.map((event) => event.seq),
    [0, 1]
  );
});

test("events command shows empty message line for unknown job without --json", () => {
  const workspace = makeTempDir();
  const result = run("node", [SCRIPT, "events", "ghost-job-2", "--cwd", workspace]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No events yet/);
});
