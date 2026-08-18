import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, messagesTokens, maybeCompact } from "../src/compact.js";

test("estimates tokens at roughly 4 chars per token", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(100)), 25);
});

test("sums token estimates across messages including per-message overhead", () => {
  // messagesTokens serializes each message (JSON.stringify), so the count
  // includes role keys, braces and content quoting — matching how real
  // OpenAI-compatible tokenizers charge per-message overhead.
  const messages = [
    { role: "system", content: "sys" },                 // 33 chars -> 9 tokens
    { role: "user", content: "a".repeat(100) }          // 127 chars -> 32 tokens
  ];
  assert.equal(messagesTokens(messages), 9 + 32);
  // Overhead must never be negative: JSON-serialized estimate is always
  // >= the content-only estimate for non-empty messages.
  const contentOnly = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  assert.ok(messagesTokens(messages) >= contentOnly);
});

test("maybeCompact is best-effort and never throws without a provider", async () => {
  const session = {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "a".repeat(5000) },
      { role: "assistant", content: "b".repeat(5000) }
    ]
  };
  const config = { compaction: { enabled: true, thresholdTokens: 1000, keepRecent: 2 } };
  const result = await maybeCompact(config, session);
  assert.equal(result.compacted, false);
  assert.equal(session.messages.length, 3); // untouched on failure
});

test("maybeCompact stays inert when disabled or under threshold", async () => {
  const config = { compaction: { enabled: false, thresholdTokens: 1, keepRecent: 2 } };
  const session = { messages: [{ role: "user", content: "x".repeat(100) }] };
  const result = await maybeCompact(config, session);
  assert.equal(result.compacted, false);
});
