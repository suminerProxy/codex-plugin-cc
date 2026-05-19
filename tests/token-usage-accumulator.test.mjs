import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // run shared env-isolation side effect
import {
  applyTurnNotification,
  createTurnCaptureState
} from "../plugins/codex/scripts/lib/codex.mjs";

test("createTurnCaptureState defaults tokenUsage to null", () => {
  const state = createTurnCaptureState("thr_main", {});
  assert.equal(state.tokenUsage, null);
});

test("applyTurnNotification stores tokenUsage from params.usage", () => {
  const state = createTurnCaptureState("thr_main", {});
  applyTurnNotification(state, {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thr_main",
      usage: { inputTokens: 1234, outputTokens: 56, cachedInputTokens: 100 }
    }
  });

  assert.deepEqual(state.tokenUsage, {
    inputTokens: 1234,
    outputTokens: 56,
    cachedInputTokens: 100
  });
});

test("applyTurnNotification replaces tokenUsage on each update (codex sends cumulative totals)", () => {
  const state = createTurnCaptureState("thr_main", {});

  applyTurnNotification(state, {
    method: "thread/tokenUsage/updated",
    params: { threadId: "thr_main", usage: { inputTokens: 100, outputTokens: 10 } }
  });
  assert.deepEqual(state.tokenUsage, { inputTokens: 100, outputTokens: 10 });

  // codex emits cumulative totals on every update, so a later notification
  // with a larger number must replace the earlier value (not be summed with
  // it). 100+250 would yield 350 incorrectly; we want 250.
  applyTurnNotification(state, {
    method: "thread/tokenUsage/updated",
    params: { threadId: "thr_main", usage: { inputTokens: 250, outputTokens: 30 } }
  });
  assert.deepEqual(state.tokenUsage, { inputTokens: 250, outputTokens: 30 });
});

test("applyTurnNotification leaves tokenUsage null when no tokenUsage event arrives", () => {
  const state = createTurnCaptureState("thr_main", {});

  applyTurnNotification(state, {
    method: "thread/started",
    params: { thread: { id: "thr_main", name: "test thread" } }
  });
  applyTurnNotification(state, {
    method: "turn/started",
    params: { threadId: "thr_main", turn: { id: "trn_001" } }
  });

  assert.equal(state.tokenUsage, null);
});

test("applyTurnNotification falls back to params.tokenUsage alias when params.usage is absent", () => {
  const state = createTurnCaptureState("thr_main", {});
  applyTurnNotification(state, {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thr_main",
      tokenUsage: { inputTokens: 42, outputTokens: 7 }
    }
  });

  assert.deepEqual(state.tokenUsage, { inputTokens: 42, outputTokens: 7 });
});

test("applyTurnNotification falls back to entire params object when neither usage nor tokenUsage is present", () => {
  // Forward-compat: future codex versions might flatten the schema and put
  // token counts directly on params. We capture the whole payload as a
  // last-resort fallback so render-side decoding can still inspect it.
  const state = createTurnCaptureState("thr_main", {});
  applyTurnNotification(state, {
    method: "thread/tokenUsage/updated",
    params: { threadId: "thr_main", inputTokens: 999, outputTokens: 11 }
  });

  assert.equal(state.tokenUsage.inputTokens, 999);
  assert.equal(state.tokenUsage.outputTokens, 11);
});

test("applyTurnNotification handles thread/tokenUsage/updated without params gracefully", () => {
  const state = createTurnCaptureState("thr_main", {});
  applyTurnNotification(state, { method: "thread/tokenUsage/updated", params: {} });

  // empty params is the last-resort fallback; the empty object is captured
  // verbatim — never throws, never crashes the worker.
  assert.deepEqual(state.tokenUsage, {});
});

test("applyTurnNotification captures real codex 0.131 nested schema (total + last + modelContextWindow)", () => {
  // This is the actual wire payload observed from codex-cli 0.131.0-alpha.9:
  // `params.tokenUsage` wraps both a cumulative `total` and a `last` (most
  // recent turn) snapshot, plus the model's context window. We store the
  // whole wrapper so downstream render code can pick which view to show.
  const state = createTurnCaptureState("thr_main", {});
  applyTurnNotification(state, {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thr_main",
      turnId: "trn_001",
      tokenUsage: {
        total: {
          totalTokens: 33357,
          inputTokens: 33227,
          cachedInputTokens: 2432,
          outputTokens: 130,
          reasoningOutputTokens: 33
        },
        last: {
          totalTokens: 33357,
          inputTokens: 33227,
          cachedInputTokens: 2432,
          outputTokens: 130,
          reasoningOutputTokens: 33
        },
        modelContextWindow: 258400
      }
    }
  });

  assert.equal(state.tokenUsage.total.inputTokens, 33227);
  assert.equal(state.tokenUsage.total.outputTokens, 130);
  assert.equal(state.tokenUsage.total.cachedInputTokens, 2432);
  assert.equal(state.tokenUsage.modelContextWindow, 258400);
});
