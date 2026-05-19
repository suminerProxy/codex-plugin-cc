import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { readJobEvents } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const start = Date.now();
  let lastValue = null;
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    lastValue = value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(lastValue)}`);
}

test(
  "watchdog emits phase:'stuck' when codex stops sending notifications mid-turn",
  { timeout: 30000 },
  async () => {
    const repo = makeTempDir();
    const binDir = makeTempDir();
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    run("git", ["add", "README.md"], { cwd: repo });
    run("git", ["commit", "-m", "init"], { cwd: repo });

    // Fake codex responds to thread/start + turn/start but then sends no
    // notifications. The shared app-server is silent so the worker's stall
    // watchdog observes lastEventAt grow stale and emits a stuck record.
    installFakeCodex(binDir, "hang-after-turn-start");

    const env = buildEnv(binDir);
    // Aggressive 1s threshold so the watchdog setInterval (which ticks every
    // 5s) flags the first quiet stretch as stuck. We deliberately don't lower
    // the tick interval — that's part of the contract we're testing.
    env.CODEX_COMPANION_STALL_SECONDS = "1";

    const launched = run(
      "node",
      [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"],
      {
        cwd: repo,
        env
      }
    );
    assert.equal(launched.status, 0, launched.stderr);
    const launchPayload = JSON.parse(launched.stdout);
    const jobId = launchPayload.jobId;
    assert.ok(jobId, `expected a job id in launch payload: ${launched.stdout}`);

    let stuckEvent = null;
    try {
      // Watchdog ticks every 5s; with a 1s threshold the first tick after the
      // hang fires within ~5-6s of worker startup. Poll up to 12s to absorb
      // CI jitter (macOS setInterval can drift under load).
      stuckEvent = await waitFor(
        () => {
          const events = readJobEvents(repo, jobId);
          return events.find((event) => event.type === "watchdog" && event.phase === "stuck") ?? null;
        },
        { timeoutMs: 12000, intervalMs: 250 }
      );
    } finally {
      // Always cancel — even if the assertion above already failed we don't
      // want to leak a detached worker beyond the test.
      run("node", [SCRIPT, "cancel", jobId, "--json", "--cwd", repo], { env });
    }

    assert.ok(stuckEvent, "expected at least one watchdog stuck event on the job stream");
    // Threshold is 1s; allow ~30% slack for macOS setInterval drift so we
    // don't flake under CI load. Anything below ~700ms would indicate the
    // contract drifted (e.g. CODEX_COMPANION_STALL_SECONDS ignored).
    assert.ok(
      typeof stuckEvent.stallMs === "number" && stuckEvent.stallMs >= 700,
      `stallMs should reflect the configured threshold; got ${stuckEvent.stallMs}`
    );
    assert.equal(typeof stuckEvent.since, "string", "since timestamp should be set");
    assert.equal(typeof stuckEvent.ts, "string", "ts should be set on the watchdog event");
    assert.equal(typeof stuckEvent.seq, "number", "seq should be set");

    // Final teardown: kill the broker / shared app-server so subsequent tests
    // (or this test on re-run) don't see a lingering child.
    const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        cwd: repo
      })
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  }
);
