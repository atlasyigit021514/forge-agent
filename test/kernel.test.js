import test from "node:test";
import assert from "node:assert/strict";
import { buildKernelLedger, buildKernelMessages } from "../src/kernel.js";
import { getToolDefinitions, activateToolGroup } from "../src/tools.js";

test("Token Kernel preserves task and latest complete tool exchange", () => {
  const messages = [
    { role: "system", content: "very long system prompt" },
    { role: "user", content: "inspect the project" },
    { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "list_files", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "file-a" },
    { role: "assistant", content: null, tool_calls: [{ id: "b", type: "function", function: { name: "read_file", arguments: "{\"path\":\"x\"}" } }] },
    { role: "tool", tool_call_id: "b", content: "exact latest result" }
  ];
  const built = buildKernelMessages({ originalTask: "inspect the project", messages }, { optimization: { tokenKernel: {} } });
  assert.equal(built[1].content, "inspect the project");
  assert.ok(built.some((item) => item.content?.includes("KERNEL LEDGER")));
  assert.deepEqual(built.slice(-2), messages.slice(-2));
  assert.ok(built[0].content.length < 500);
});

test("kernel ledger is deterministic and bounded", () => {
  const messages = [];
  for (let i = 0; i < 5; i++) {
    messages.push({ role: "assistant", tool_calls: [{ id: `x${i}`, function: { name: "read_file", arguments: `{\"path\":\"${i}\"}` } }] });
    messages.push({ role: "tool", tool_call_id: `x${i}`, content: `result-${i}` });
  }
  const ledger = buildKernelLedger(messages, { maxLedgerEntries: 2 });
  assert.equal(ledger.length, 2);
  assert.ok(ledger[1].includes("result-4"));
});

test("Token Kernel exposes a small core and can activate groups", () => {
  const config = { optimization: { tokenKernel: { enabled: true }, graphify: { enabled: true }, contextVirtualMemory: { enabled: true } } };
  const session = {};
  const initial = getToolDefinitions(config, session).map((item) => item.function.name);
  assert.ok(initial.includes("read_file"));
  assert.ok(initial.includes("load_tool_group"));
  assert.ok(!initial.includes("memory_save"));
  activateToolGroup(session, "memory");
  const expanded = getToolDefinitions(config, session).map((item) => item.function.name);
  assert.ok(expanded.includes("memory_save"));
});
