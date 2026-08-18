import test from "node:test";
import assert from "node:assert/strict";
import { deduplicateToolResult, compressToolResult, virtualizeToolResult, recallContextPage } from "../src/optimization.js";
import { getToolDefinitions } from "../src/tools.js";

test("large repeated tool results are replaced with a stable reference", () => {
  const session = { turns: 2 };
  const text = "x".repeat(2000);
  assert.equal(deduplicateToolResult(session, text, {}).content, text);
  const second = deduplicateToolResult(session, text, {});
  assert.equal(second.deduplicated, true);
  assert.ok(second.content.includes("repeated_tool_result"));
  assert.ok(second.savedChars > 1500);
});

test("semantic compression is inert unless explicitly enabled", async () => {
  const text = "keep exactly";
  assert.deepEqual(await compressToolResult(text, {}), { content: text, savedChars: 0, compressed: false });
});

test("Graphify tool can be disabled without touching other tools", () => {
  assert.ok(getToolDefinitions({ optimization: { graphify: { enabled: true } } }).some((x) => x.function.name === "graphify"));
  assert.ok(!getToolDefinitions({ optimization: { graphify: { enabled: false } } }).some((x) => x.function.name === "graphify"));
});

test("large results become lossless, recallable context pages", () => {
  const session = { turns: 1 };
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}: unique-value-${i}`).join("\n");
  const paged = virtualizeToolResult(session, text, { minChars: 1000, pageChars: 1200, previewChars: 80 });
  assert.equal(paged.virtualized, true);
  assert.ok(paged.savedChars > 0);
  const map = JSON.parse(paged.content).context_virtual_memory;
  assert.equal(map.originalChars, text.length);
  assert.ok(map.pages.length > 1);
  const reconstructed = map.pages.map((item) => recallContextPage(session, item.pageId).content).join("");
  assert.equal(reconstructed, text);
});

test("recall schema is injected only while virtual pages exist", () => {
  const config = { optimization: { graphify: { enabled: false }, contextVirtualMemory: { enabled: true } } };
  assert.ok(!getToolDefinitions(config, {}).some((x) => x.function.name === "context_recall"));
  const session = { contextPages: new Map([["abc:1", { content: "x" }]]) };
  assert.ok(getToolDefinitions(config, session).some((x) => x.function.name === "context_recall"));
});

test("virtual page storage respects a non-evicting session cap", () => {
  const session = {};
  const text = "capacity-test\n".repeat(600);
  const result = virtualizeToolResult(session, text, { minChars: 1000, pageChars: 1000, maxSessionChars: 2000 });
  assert.equal(result.virtualized, false);
  assert.equal(result.capacityExceeded, true);
  assert.equal(session.contextPages.size, 0);
});
