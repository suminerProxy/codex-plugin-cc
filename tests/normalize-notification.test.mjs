import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // run shared env-isolation side effect
import { normalizeNotification } from "../plugins/codex/scripts/lib/codex.mjs";

function makeState(overrides = {}) {
  return {
    threadId: "thr_main",
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    ...overrides
  };
}

test("normalizeNotification: thread/started carries thread id and starting phase", () => {
  const state = makeState();
  const event = normalizeNotification(state, {
    method: "thread/started",
    params: { thread: { id: "thr_xyz", name: "rescue task" } }
  });

  assert.equal(event.method, "thread/started");
  assert.equal(event.threadId, "thr_xyz");
  assert.equal(event.phase, "starting");
  assert.equal(event.turnId, null);
  assert.equal(event.itemType, null);
  assert.equal(event.lifecycle, null);
  assert.match(event.message, /Thread started/);
  assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("normalizeNotification: turn/started captures turnId and 'thinking' phase", () => {
  const state = makeState();
  const event = normalizeNotification(state, {
    method: "turn/started",
    params: { threadId: "thr_main", turn: { id: "trn_001" } }
  });

  assert.equal(event.method, "turn/started");
  assert.equal(event.threadId, "thr_main");
  assert.equal(event.turnId, "trn_001");
  assert.equal(event.phase, "thinking");
});

test("normalizeNotification: item/started commandExecution maps to running phase", () => {
  const state = makeState();
  state.threadTurnIds.set("thr_main", "trn_001");

  const event = normalizeNotification(state, {
    method: "item/started",
    params: {
      threadId: "thr_main",
      item: { type: "commandExecution", command: "git status" }
    }
  });

  assert.equal(event.method, "item/started");
  assert.equal(event.itemType, "commandExecution");
  assert.equal(event.lifecycle, "started");
  assert.equal(event.turnId, "trn_001");
  assert.equal(event.phase, "running");
  assert.match(event.message, /Running command: git status/);
});

test("normalizeNotification: item/started commandExecution detects verifying phase for test commands", () => {
  const state = makeState();
  const event = normalizeNotification(state, {
    method: "item/started",
    params: {
      threadId: "thr_main",
      item: { type: "commandExecution", command: "npm test" }
    }
  });

  // looksLikeVerificationCommand recognizes test/check/lint patterns
  assert.equal(event.phase, "verifying");
});

test("normalizeNotification: item/started fileChange maps to editing phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "item/started",
    params: {
      threadId: "thr_main",
      item: { type: "fileChange", changes: [{}, {}, {}] }
    }
  });

  assert.equal(event.itemType, "fileChange");
  assert.equal(event.phase, "editing");
  assert.match(event.message, /3 file change/);
});

test("normalizeNotification: item/started mcpToolCall maps to investigating phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "item/started",
    params: {
      threadId: "thr_main",
      item: { type: "mcpToolCall", server: "context7", tool: "resolve-library-id" }
    }
  });

  assert.equal(event.itemType, "mcpToolCall");
  assert.equal(event.phase, "investigating");
  assert.match(event.message, /context7\/resolve-library-id/);
});

test("normalizeNotification: item/started webSearch maps to investigating phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "item/started",
    params: {
      threadId: "thr_main",
      item: { type: "webSearch", query: "claude code agent sdk" }
    }
  });

  assert.equal(event.itemType, "webSearch");
  assert.equal(event.phase, "investigating");
  assert.match(event.message, /Searching/);
});

test("normalizeNotification: item/completed carries completed lifecycle + exit code", () => {
  const event = normalizeNotification(makeState(), {
    method: "item/completed",
    params: {
      threadId: "thr_main",
      item: { type: "commandExecution", command: "echo hi", status: "completed", exitCode: 0 }
    }
  });

  assert.equal(event.method, "item/completed");
  assert.equal(event.lifecycle, "completed");
  assert.equal(event.itemType, "commandExecution");
  assert.match(event.message, /Command completed/);
  assert.match(event.message, /exit 0/);
});

test("normalizeNotification: turn/completed with status=completed yields 'completed' phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "turn/completed",
    params: { threadId: "thr_main", turn: { id: "trn_001", status: "completed" } }
  });

  assert.equal(event.method, "turn/completed");
  assert.equal(event.phase, "completed");
  assert.equal(event.turnId, "trn_001");
});

test("normalizeNotification: turn/completed with non-completed status yields 'finalizing' phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "turn/completed",
    params: { threadId: "thr_main", turn: { id: "trn_001", status: "cancelled" } }
  });

  assert.equal(event.phase, "finalizing");
  assert.match(event.message, /cancelled/);
});

test("normalizeNotification: error notification yields 'failed' phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "error",
    params: { error: { message: "context length exceeded", code: "context_overflow" } }
  });

  assert.equal(event.method, "error");
  assert.equal(event.phase, "failed");
  assert.match(event.message, /context length exceeded/);
  assert.equal(event.raw.code, "context_overflow");
});

test("normalizeNotification: unknown method falls back to 'unknown' phase without throwing", () => {
  const event = normalizeNotification(makeState(), {
    method: "thread/compact/started",
    params: { threadId: "thr_main" }
  });

  assert.equal(event.method, "thread/compact/started");
  assert.equal(event.phase, "unknown");
  assert.equal(event.threadId, "thr_main");
});

test("normalizeNotification: handles malformed message without crashing", () => {
  // No method, no params, weird shape — should still return a valid record
  const event = normalizeNotification(makeState(), {});

  assert.equal(event.method, null);
  assert.equal(event.phase, "unknown");
  assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("normalizeNotification: thread/status/changed active -> thinking phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "thread/status/changed",
    params: { threadId: "thr_main", status: { type: "active", activeFlags: [] } }
  });

  assert.equal(event.method, "thread/status/changed");
  assert.equal(event.phase, "thinking");
  assert.equal(event.threadId, "thr_main");
  assert.match(event.message, /active/);
});

test("normalizeNotification: thread/status/changed systemError -> failed phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "thread/status/changed",
    params: { threadId: "thr_main", status: { type: "systemError" } }
  });

  assert.equal(event.phase, "failed");
  assert.match(event.message, /system error/i);
});

test("normalizeNotification: thread/status/changed unknown status type -> unknown (forward-compat)", () => {
  const event = normalizeNotification(makeState(), {
    method: "thread/status/changed",
    params: { threadId: "thr_main", status: { type: "futureStatusWeDontKnow" } }
  });

  assert.equal(event.phase, "unknown");
});

test("normalizeNotification: warning -> warning phase with message body", () => {
  const event = normalizeNotification(makeState(), {
    method: "warning",
    params: { threadId: "thr_main", message: "Exceeded skills context budget of 2%." }
  });

  assert.equal(event.method, "warning");
  assert.equal(event.phase, "warning");
  assert.match(event.message, /Exceeded skills context budget/);
});

test("normalizeNotification: item/started userMessage -> thinking phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "item/started",
    params: {
      threadId: "thr_main",
      item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "Hi" }] }
    }
  });

  assert.equal(event.itemType, "userMessage");
  assert.equal(event.phase, "thinking");
  assert.match(event.message, /User input received/);
});

test("normalizeNotification: item/started assistantMessage -> thinking phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "item/started",
    params: {
      threadId: "thr_main",
      item: { type: "assistantMessage", id: "a1" }
    }
  });

  assert.equal(event.itemType, "assistantMessage");
  assert.equal(event.phase, "thinking");
});

test("normalizeNotification: item/started reasoning -> thinking phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "item/started",
    params: { threadId: "thr_main", item: { type: "reasoning" } }
  });

  assert.equal(event.itemType, "reasoning");
  assert.equal(event.phase, "thinking");
});

test("normalizeNotification: thread/status/changed idle -> idle phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "thread/status/changed",
    params: { threadId: "thr_main", status: { type: "idle" } }
  });

  assert.equal(event.phase, "idle");
  assert.match(event.message, /idle/i);
});

test("normalizeNotification: thread/tokenUsage/updated -> metering phase with in/out tokens", () => {
  const event = normalizeNotification(makeState(), {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thr_main",
      usage: { inputTokens: 1234, outputTokens: 56, cachedInputTokens: 100 }
    }
  });

  assert.equal(event.method, "thread/tokenUsage/updated");
  assert.equal(event.phase, "metering");
  assert.match(event.message, /in=1234/);
  assert.match(event.message, /out=56/);
  assert.match(event.message, /cached=100/);
});

test("normalizeNotification: thread/tokenUsage/updated without usage still yields metering phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "thread/tokenUsage/updated",
    params: { threadId: "thr_main" }
  });

  assert.equal(event.phase, "metering");
  assert.match(event.message, /Token usage updated/i);
});

test("normalizeNotification: thread/tokenUsage/updated decodes real codex 0.131 nested tokenUsage payload", () => {
  // Wire-observed: codex-cli 0.131.0-alpha.9 wraps counts inside
  // params.tokenUsage.total. Verify the message string surfaces the cumulative
  // totals (in/out/cached) so the events stream is useful to main-loop Claude.
  const event = normalizeNotification(makeState(), {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thr_main",
      turnId: "trn_001",
      tokenUsage: {
        total: {
          totalTokens: 33357,
          inputTokens: 33227,
          cachedInputTokens: 2432,
          outputTokens: 130
        },
        last: {
          inputTokens: 33227,
          outputTokens: 130
        },
        modelContextWindow: 258400
      }
    }
  });

  assert.equal(event.phase, "metering");
  assert.match(event.message, /in=33227/);
  assert.match(event.message, /out=130/);
  assert.match(event.message, /cached=2432/);
});

test("normalizeNotification: item/started agentMessage with text shows reply preview", () => {
  const event = normalizeNotification(makeState(), {
    method: "item/started",
    params: {
      threadId: "thr_main",
      item: { type: "agentMessage", text: "pong" }
    }
  });

  assert.equal(event.itemType, "agentMessage");
  assert.equal(event.phase, "thinking");
  assert.match(event.message, /Codex replying: pong/);
});

test("normalizeNotification: item/completed agentMessage with content[].text shows reply", () => {
  const event = normalizeNotification(makeState(), {
    method: "item/completed",
    params: {
      threadId: "thr_main",
      item: { type: "agentMessage", content: [{ type: "text", text: "Final answer: 42" }] }
    }
  });

  assert.equal(event.itemType, "agentMessage");
  assert.equal(event.phase, "thinking");
  assert.match(event.message, /Codex replied: Final answer: 42/);
});

test("normalizeNotification: turn/plan/updated -> thinking phase with step summary", () => {
  // Wire-observed schema from codex 0.131: { threadId, turnId, explanation:
  // null, plan: [{ step, status }] }. Status values seen in the wild include
  // "completed", "inProgress", "pending".
  const event = normalizeNotification(makeState(), {
    method: "turn/plan/updated",
    params: {
      threadId: "thr_main",
      turnId: "trn_001",
      explanation: null,
      plan: [
        { step: "确认仓库现状和约束", status: "completed" },
        { step: "实现带类型提示/docstring 的 Trie", status: "inProgress" },
        { step: "补 pytest 覆盖指定场景", status: "pending" },
        { step: "运行 pytest 验证", status: "pending" }
      ]
    }
  });

  assert.equal(event.method, "turn/plan/updated");
  assert.equal(event.phase, "thinking");
  assert.equal(event.threadId, "thr_main");
  assert.equal(event.turnId, "trn_001");
  assert.equal(event.itemType, null);
  assert.equal(event.lifecycle, null);
  assert.match(event.message, /Plan updated/);
  assert.match(event.message, /4 steps/);
  assert.match(event.message, /1 done/);
  assert.match(event.message, /1 in progress/);
  assert.match(event.message, /2 pending/);
  // raw preserves the full plan so main-loop Claude can render step contents
  assert.equal(event.raw.plan.length, 4);
});

test("normalizeNotification: turn/plan/updated without plan array yields generic message", () => {
  const event = normalizeNotification(makeState(), {
    method: "turn/plan/updated",
    params: { threadId: "thr_main", turnId: "trn_001" }
  });

  assert.equal(event.phase, "thinking");
  assert.match(event.message, /Plan updated/);
});

test("normalizeNotification: turn/plan/updated falls back to state.threadTurnIds when params.turnId absent", () => {
  // Defensive: covers older/future codex builds that may omit turnId from
  // plan-update notifications. We've already registered the active turn via
  // turn/started, so the normalizer should still surface it.
  const state = makeState();
  state.threadTurnIds.set("thr_main", "trn_inferred");
  const event = normalizeNotification(state, {
    method: "turn/plan/updated",
    params: { threadId: "thr_main", plan: [{ step: "x", status: "pending" }] }
  });

  assert.equal(event.turnId, "trn_inferred");
});

test("normalizeNotification: turn/diff/updated -> editing phase with file count", () => {
  // Wire-observed: raw.diff is a unified-diff string. Count files by
  // matching `^diff --git ` headers — observed in real codex 0.131 traces
  // when codex was creating test_trie.py alongside trie.py.
  const diff =
    "diff --git a/trie.py b/trie.py\nnew file mode 100644\n--- /dev/null\n+++ b/trie.py\n@@ -0,0 +1,5 @@\n+class Trie:\n+    pass\n" +
    "diff --git a/test_trie.py b/test_trie.py\nnew file mode 100644\n--- /dev/null\n+++ b/test_trie.py\n@@ -0,0 +1,3 @@\n+from trie import Trie\n";
  const event = normalizeNotification(makeState(), {
    method: "turn/diff/updated",
    params: {
      threadId: "thr_main",
      turnId: "trn_001",
      diff
    }
  });

  assert.equal(event.method, "turn/diff/updated");
  assert.equal(event.phase, "editing");
  assert.equal(event.threadId, "thr_main");
  assert.equal(event.turnId, "trn_001");
  assert.equal(event.itemType, null);
  assert.match(event.message, /Diff updated/);
  assert.match(event.message, /2 files/);
  // raw preserves the full diff string for downstream patch rendering
  assert.equal(event.raw.diff, diff);
});

test("normalizeNotification: turn/diff/updated without diff string yields generic message", () => {
  const event = normalizeNotification(makeState(), {
    method: "turn/diff/updated",
    params: { threadId: "thr_main", turnId: "trn_001" }
  });

  assert.equal(event.phase, "editing");
  assert.match(event.message, /Diff updated/);
  // No file count when diff missing
  assert.doesNotMatch(event.message, /file/);
});

test("normalizeNotification: item/commandExecution/outputDelta -> running phase with byte count", () => {
  // Wire-observed: codex 0.131 streams stdout chunks during a running
  // commandExecution item. params = { threadId, turnId, itemId, delta,
  // stream: null }. Phase stays "running" because the command hasn't finished
  // — this is a progress signal, not a lifecycle transition.
  const event = normalizeNotification(makeState(), {
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thr_main",
      turnId: "trn_001",
      itemId: "call_JbBZeYtNazPjdT6f76bR8adX",
      delta: "hello world\n",
      stream: null
    }
  });

  assert.equal(event.method, "item/commandExecution/outputDelta");
  assert.equal(event.phase, "running");
  assert.equal(event.itemType, "commandExecution");
  assert.equal(event.lifecycle, "delta");
  assert.equal(event.threadId, "thr_main");
  assert.equal(event.turnId, "trn_001");
  assert.match(event.message, /Command output \+12 bytes/);
  // raw preserves the chunk so consumers can join deltas in seq order
  assert.equal(event.raw.delta, "hello world\n");
  assert.equal(event.raw.itemId, "call_JbBZeYtNazPjdT6f76bR8adX");
});

test("normalizeNotification: item/commandExecution/outputDelta with empty delta still surfaces running phase", () => {
  const event = normalizeNotification(makeState(), {
    method: "item/commandExecution/outputDelta",
    params: { threadId: "thr_main", turnId: "trn_001", itemId: "call_x", delta: "" }
  });

  assert.equal(event.phase, "running");
  assert.equal(event.itemType, "commandExecution");
  assert.match(event.message, /Command output delta/);
});
