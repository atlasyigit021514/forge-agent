// Shared measurement helpers for token benchmarks.
// Uses the same estimator as src/compact.js: ~4 chars per token.

export function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

export function payloadTokens(payload) {
  return estimateTokens(JSON.stringify(payload));
}

// Wrap globalThis.fetch to capture chat/completions payloads and latency.
// Pass `capture` = true to also tee response bodies (used by the real runner).
export function captureFetch() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const isChat = String(url).endsWith("/chat/completions");
    const started = Date.now();
    let response;
    let bodyText = null;
    if (isChat && options.body) {
      const payload = JSON.parse(options.body);
      calls.push({
        kind: "chat",
        payload,
        inputTokens: payloadTokens(payload),
        outputTokens: 0,
        latencyMs: 0,
        usage: null,
        toolCalls: payload.tools?.length || 0
      });
    }
    response = await original(url, options);
    if (isChat && calls.length) {
      const entry = calls[calls.length - 1];
      entry.latencyMs = Date.now() - started;
      // Tee via clone so provider.js can still consume the original body.
      if (response.ok) {
        try {
          const clone = response.clone();
          bodyText = await clone.text();
          const body = JSON.parse(bodyText);
          entry.usage = body.usage || null;
          entry.outputTokens = estimateTokens(bodyText);
        } catch { /* non-JSON or already consumed */ }
      }
    }
    return response;
  };
  return {
    calls,
    restore() { globalThis.fetch = original; }
  };
}

export function summarize(calls, label) {
  const input = calls.reduce((s, c) => s + (c.inputTokens || 0), 0);
  const output = calls.reduce((s, c) => s + (c.outputTokens || 0), 0);
  const peak = calls.reduce((s, c) => Math.max(s, (c.inputTokens || 0) + (c.outputTokens || 0)), 0);
  const toolCalls = calls.reduce((s, c) => s + (c.toolCalls || 0), 0);
  const latency = calls.reduce((s, c) => s + (c.latencyMs || 0), 0);
  return {
    label,
    calls: calls.length,
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    peakContextTokens: peak,
    toolCalls,
    avgTokensPerCall: calls.length ? Math.round((input + output) / calls.length) : 0,
    latencyMs: latency
  };
}
