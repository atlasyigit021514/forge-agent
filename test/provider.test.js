import test from "node:test";
import assert from "node:assert/strict";
import { chatCompletion } from "../src/provider.js";

function config(maxRetries = 3) {
  return {
    provider: { baseUrl: "https://models.example/v1", apiKey: "test", model: "test-model", maxRetries, retryBaseMs: 1 },
    agent: { temperature: 0 }
  };
}

function streamResponse(chunks) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" }
  });
}

test("streams content deltas and assembles the assistant message", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return streamResponse([
      { choices: [{ delta: { role: "assistant", content: "hel" } }] },
      { choices: [{ delta: { content: "lo" } }] }
    ]);
  };
  const deltas = [];
  try {
    const result = await chatCompletion(config(), [{ role: "user", content: "hi" }], [], () => {}, (text) => deltas.push(text));
    assert.equal(result.message.content, "hello");
    assert.deepEqual(deltas, ["hel", "lo"]);
  } finally { globalThis.fetch = original; }
});

test("assembles streamed tool calls", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => streamResponse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_", arguments: "{\"pa" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: "th\":\"x\"}" } }] } }] }
  ]);
  try {
    const result = await chatCompletion(config(), [], []);
    assert.equal(result.message.tool_calls[0].function.name, "read_file");
    assert.equal(result.message.tool_calls[0].function.arguments, '{"path":"x"}');
  } finally { globalThis.fetch = original; }
});

test("retries transient failures and returns the successful response", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 3) return new Response("busy", { status: 503 });
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  };
  try {
    const result = await chatCompletion(config(), [{ role: "user", content: "hi" }], []);
    assert.equal(result.message.content, "ok");
    assert.equal(result.attempts, 3);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test("does not retry permanent client errors", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("bad key", { status: 401 }); };
  try {
    await assert.rejects(() => chatCompletion(config(), [], []), /401/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("requests streaming usage only when enabled", async () => {
  const original = globalThis.fetch;
  const payloads = [];
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return streamResponse([{ choices: [{ delta: { content: "ok" } }] }]);
  };
  try {
    await chatCompletion({ ...config(), provider: { ...config().provider, includeUsage: true } }, [], []);
    await chatCompletion(config(), [], []);
    assert.deepEqual(payloads[0].stream_options, { include_usage: true });
    assert.equal(payloads[1].stream_options, undefined);
  } finally { globalThis.fetch = original; }
});
