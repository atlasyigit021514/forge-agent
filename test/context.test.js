import test from "node:test";
import assert from "node:assert/strict";
import { elideText, windowStart, buildModelMessages, mergeCompactedSummaries } from "../src/context.js";
import { searchMemories } from "../src/memory.js";

test("elideText leaves short text untouched", () => {
  assert.equal(elideText("short", 100), "short");
});

test("elideText keeps head and tail with a truncation marker", () => {
  const out = elideText("a".repeat(1000), 200);
  assert.ok(out.includes("[TRUNCATED"));
  assert.ok(out.startsWith("a".repeat(140)));
  assert.ok(out.endsWith("a".repeat(40)));
  assert.ok(out.length < 1000);
});

test("windowStart returns 0 when under the window size", () => {
  const rest = [
    { role: "user", content: "task" },
    { role: "assistant", tool_calls: [{ id: "1" }] },
    { role: "tool", tool_call_id: "1", content: "x" }
  ];
  assert.equal(windowStart(rest, 24), 0);
});

test("windowStart cuts at a completed-turn boundary, never mid-turn", () => {
  // 30 messages: a giant multi-turn history. The last turn is complete.
  const rest = [];
  for (let i = 0; i < 12; i++) {
    rest.push({ role: "assistant", tool_calls: [{ id: `a${i}` }] });
    rest.push({ role: "tool", tool_call_id: `a${i}`, content: "r".repeat(200) });
  }
  // ...then a completed final turn with content but no tool_calls
  rest.push({ role: "assistant", content: "final answer" });
  const start = windowStart(rest, 24);
  assert.ok(start >= 1);
  assert.ok(start <= rest.length - 1);
  // The boundary message must be an assistant (self-contained window start).
  assert.equal(rest[start].role, "assistant");
  // Window must fit the budget.
  assert.ok(rest.length - start <= 24);
});

test("buildModelMessages preserves the original task statement when windowed", () => {
  const messages = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: "assistant", tool_calls: [{ id: `a${i}` }] });
    messages.push({ role: "tool", tool_call_id: `a${i}`, content: "r".repeat(300) });
  }
  messages.push({ role: "assistant", content: "done" });
  const built = buildModelMessages({ messages }, { context: { maxRecentMessages: 12 } });
  const roles = built.map((m) => m.role);
  assert.ok(roles.includes("user") === false); // no user message in this trace
  assert.ok(roles[0] === "system");
  assert.ok(built.length < messages.length);
  // window must start at a self-contained boundary (an assistant message)
  const first = built.slice(1)[0];
  assert.equal(first.role, "assistant");
});

test("buildModelMessages keeps first user message if present", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "THE TASK" }
  ];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: "assistant", tool_calls: [{ id: `a${i}` }] });
    messages.push({ role: "tool", tool_call_id: `a${i}`, content: "r".repeat(300) });
  }
  messages.push({ role: "assistant", content: "done" });
  const built = buildModelMessages({ messages }, { context: { maxRecentMessages: 12 } });
  assert.ok(built.some((m) => m.content === "THE TASK"));
});

test("mergeCompactedSummaries collapses multiple summary blocks into one", () => {
  const messages = [
    { role: "system", content: "original prompt" },
    { role: "system", content: "[COMPACTED CONTEXT]\nsummary one" },
    { role: "system", content: "[COMPACTED CONTEXT]\nsummary two" },
    { role: "user", content: "hello" }
  ];
  const merged = mergeCompactedSummaries(messages);
  assert.equal(merged.filter((m) => m.role === "system").length, 2);
  assert.ok(merged.some((m) => m.content.includes("summary one") && m.content.includes("summary two")));
});

test("searchMemories rejects trivial queries and caps top_k", () => {
  assert.deepEqual(searchMemories("hi", 5), []);
  assert.deepEqual(searchMemories("", 5), []);
  const results = searchMemories("workspace agent memory", 3);
  assert.ok(results.length <= 3);
});
