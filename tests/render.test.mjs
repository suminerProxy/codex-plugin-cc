import test from "node:test";
import assert from "node:assert/strict";

import {
  renderJobStatusReport,
  renderReviewResult,
  renderStoredJobResult
} from "../plugins/codex/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});

test("renderJobStatusReport shows Tokens line when job has usage", () => {
  const output = renderJobStatusReport({
    id: "task-abc",
    status: "completed",
    title: "Codex Task",
    jobClass: "task",
    duration: "12s",
    usage: { inputTokens: 1234, outputTokens: 56, cachedInputTokens: 100 }
  });

  assert.match(output, /Tokens: in=1234 out=56 cached=100/);
});

test("renderJobStatusReport reads usage from job.result fallback when top-level usage missing", () => {
  const output = renderJobStatusReport({
    id: "task-def",
    status: "completed",
    title: "Codex Task",
    jobClass: "task",
    duration: "9s",
    result: { usage: { inputTokens: 500, outputTokens: 20 } }
  });

  assert.match(output, /Tokens: in=500 out=20/);
});

test("renderJobStatusReport omits Tokens line when no usage present", () => {
  const output = renderJobStatusReport({
    id: "task-ghi",
    status: "completed",
    title: "Codex Task",
    jobClass: "task",
    duration: "3s"
  });

  assert.doesNotMatch(output, /Tokens:/);
});

test("renderJobStatusReport handles partial usage (only input, no output)", () => {
  const output = renderJobStatusReport({
    id: "task-jkl",
    status: "completed",
    title: "Codex Task",
    jobClass: "task",
    duration: "5s",
    usage: { inputTokens: 42 }
  });

  assert.match(output, /Tokens: in=42/);
  assert.doesNotMatch(output, /out=/);
  assert.doesNotMatch(output, /cached=/);
});

test("renderJobStatusReport omits Tokens line when usage is empty object (no known fields)", () => {
  const output = renderJobStatusReport({
    id: "task-mno",
    status: "completed",
    title: "Codex Task",
    jobClass: "task",
    duration: "1s",
    usage: {}
  });

  // Empty usage object should not produce a "Tokens: " line with nothing
  // after the colon — that would be visual noise.
  assert.doesNotMatch(output, /Tokens:/);
});

test("renderJobStatusReport falls back to alias field names (input/output/cached)", () => {
  const output = renderJobStatusReport({
    id: "task-pqr",
    status: "completed",
    title: "Codex Task",
    jobClass: "task",
    duration: "7s",
    usage: { input: 200, output: 40, cached: 10 }
  });

  assert.match(output, /Tokens: in=200 out=40 cached=10/);
});

test("renderJobStatusReport reads real codex 0.131 nested schema (usage.total.inputTokens)", () => {
  // Wire-observed shape from codex-cli 0.131.0-alpha.9 — counts are nested
  // under `total` (cumulative) and `last` (this-turn). We surface `total`
  // because it's what /codex:status callers expect to see grow across turns.
  const output = renderJobStatusReport({
    id: "task-real",
    status: "completed",
    title: "Codex Task",
    jobClass: "task",
    duration: "11s",
    usage: {
      total: {
        totalTokens: 33357,
        inputTokens: 33227,
        cachedInputTokens: 2432,
        outputTokens: 130,
        reasoningOutputTokens: 33
      },
      last: {
        inputTokens: 33227,
        outputTokens: 130
      },
      modelContextWindow: 258400
    }
  });

  assert.match(output, /Tokens: in=33227 out=130 cached=2432/);
});

test("renderJobStatusReport falls back to usage.last when usage.total is absent", () => {
  const output = renderJobStatusReport({
    id: "task-last-only",
    status: "completed",
    title: "Codex Task",
    jobClass: "task",
    duration: "4s",
    usage: { last: { inputTokens: 50, outputTokens: 5 } }
  });

  assert.match(output, /Tokens: in=50 out=5/);
});
