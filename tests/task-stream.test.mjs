import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { readJobEvents } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

function collectStdoutLines(child) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          lines.push(JSON.parse(line));
        } catch {
          // ignore non-JSON noise; we only care about NDJSON push events
        }
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ lines, exitCode: code }));
  });
}

test(
  "task-stream pushes one NDJSON line per event and exits cleanly when job/exited fires",
  { timeout: 30000 },
  async () => {
    const repo = makeTempDir();
    const binDir = makeTempDir();
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    run("git", ["add", "README.md"], { cwd: repo });
    run("git", ["commit", "-m", "init"], { cwd: repo });

    installFakeCodex(binDir);
    const env = buildEnv(binDir);

    const child = spawn(
      process.execPath,
      [SCRIPT, "task-stream", "--cwd", repo, "Reply pong"],
      { env }
    );

    const { lines, exitCode } = await collectStdoutLines(child);

    assert.ok(lines.length >= 2, `expected multiple ndjson lines, got ${lines.length}`);

    const jobIds = new Set(lines.map((l) => l.jobId).filter(Boolean));
    assert.equal(
      jobIds.size,
      1,
      `every stdout line should carry the same jobId; got ${[...jobIds].join(",")}`
    );
    const jobId = [...jobIds][0];

    // seq monotonically increases from 0
    const seqs = lines.map((l) => l.seq);
    assert.deepEqual(
      seqs,
      seqs.map((_, i) => i),
      `seq should be 0..n in order; got ${seqs.join(",")}`
    );

    // job/exited must be the terminal record
    const exitedIdx = lines.findIndex((l) => l.type === "job/exited");
    assert.ok(exitedIdx >= 0, "stdout stream must contain a {type:'job/exited'} record");
    assert.equal(
      exitedIdx,
      lines.length - 1,
      "job/exited should be the last line of the push stream"
    );
    const exited = lines[exitedIdx];
    assert.equal(exited.phase, "completed");
    assert.equal(exited.exitCode, 0);

    // child process exit code matches success path
    assert.equal(exitCode, 0, "task-stream child should exit 0 on success");

    // events.ndjson on disk matches the push stream (durable contract intact)
    const events = readJobEvents(repo, jobId);
    const exitedOnDisk = events.find((e) => e.type === "job/exited");
    assert.ok(exitedOnDisk, "events.ndjson must also contain job/exited");
    assert.equal(exitedOnDisk.phase, "completed");

    // SessionEnd cleanup so the broker doesn't leak between tests
    run(process.execPath, [SESSION_HOOK, "SessionEnd"], { env, cwd: repo });
  }
);
