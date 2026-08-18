// Deterministic token harness: stubs the model endpoint with scripted
// assistant responses, runs the REAL agent loop + REAL tools, and reports
// per-call token cost. No API spend, fully reproducible.
import { loadConfig } from "../src/config.js";
import { createSession, runSession } from "../src/agent.js";
import { captureFetch, summarize, estimateTokens } from "./measure.js";
import { messagesTokens } from "../src/compact.js";

function scriptedToolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) }
  };
}

// Standard task used for before/after comparison.
export const STANDARD_TASK = "List the files under src/ (depth 1), read src/config.js, and report the default maxTurns value.";

// Build a scripted assistant-response sequence.
// short: list_files -> read_file -> final
// long:  12 turns of varied read_file on tools.js (exercises history growth)
export function scriptedResponses(mode = "short") {
  const responses = [];
  if (mode === "short") {
    responses.push({ role: "assistant", content: "", tool_calls: [scriptedToolCall("call_1", "list_files", { path: "src", depth: 1 })] });
    responses.push({ role: "assistant", content: "", tool_calls: [scriptedToolCall("call_2", "read_file", { path: "src/config.js" })] });
    responses.push({ role: "assistant", content: "Done. Files in src/: agent.js, compact.js, config.js, http.js, memory.js, provider.js, server.js, shells.js, skills.js, tools.js. Default maxTurns is 200." });
  } else if (mode === "xlong") {
    // 40 turns: exercises sustained windowing + compaction pressure.
    for (let i = 0; i < 40; i++) {
      const startLine = (i % 12) * 150 + 1;
      responses.push({
        role: "assistant", content: "",
        tool_calls: [scriptedToolCall(`call_${i + 1}`, "read_file", { path: "src/tools.js", startLine, endLine: startLine + 149 })]
      });
    }
    responses.push({ role: "assistant", content: "Done. Read all chunks of src/tools.js." });
  } else {
    const chunks = [
      [1, 300], [301, 600], [601, 900], [1, 200], [201, 450], [451, 700],
      [701, 950], [1, 150], [151, 350], [351, 550], [551, 750], [751, 950]
    ];
    chunks.forEach(([startLine, endLine], i) => {
      responses.push({
        role: "assistant", content: "",
        tool_calls: [scriptedToolCall(`call_${i + 1}`, "read_file", { path: "src/tools.js", startLine, endLine })]
      });
    });
    responses.push({ role: "assistant", content: "Done. Read all chunks of src/tools.js." });
  }
  return responses;
}

export async function runHarness(mode = "short", overrides = {}) {
  const config = loadConfig();
  if (overrides.thresholdTokens) config.compaction.thresholdTokens = overrides.thresholdTokens;
  if (overrides.maxRecentMessages) config.context.maxRecentMessages = overrides.maxRecentMessages;
  if (typeof overrides.contextVirtualMemory === "boolean") config.optimization.contextVirtualMemory.enabled = overrides.contextVirtualMemory;
  if (typeof overrides.tokenKernel === "boolean") config.optimization.tokenKernel.enabled = overrides.tokenKernel;
  const responses = scriptedResponses(mode);
  let idx = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const payload = JSON.parse(options.body);
    if (String(url).endsWith("/chat/completions")) {
      if (idx < responses.length) {
        const msg = responses[idx++];
        const bodyText = JSON.stringify({ choices: [{ message: msg }], usage: null });
        return new Response(bodyText, { status: 200, headers: { "content-type": "application/json" } });
      }
      // Never fall through to the real network: answer with a final message.
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "No more scripted responses; stopping." } }], usage: null }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(url, options);
  };

  const cap = captureFetch();
  try {
    const session = createSession(config, STANDARD_TASK);
    await runSession(config, session);
    const stats = summarize(cap.calls, `harness-${mode}`);
    stats.finalTurns = session.turns;
    stats.finalMessageCount = session.messages.length;
    stats.compactions = session.compactions || 0;
    stats.workingHistoryTokens = messagesTokens(session.messages);
    stats.telemetry = session.stats || null;
    stats.optimization = session.optimizationStats || null;
    stats.capCalls = cap.calls.length;
    stats.perCall = cap.calls.map((c, i) => ({ i: i + 1, inputTokens: c.inputTokens, outputTokens: c.outputTokens, sentMessages: c.payload?.messages?.length, toolsChars: c.payload?.tools ? JSON.stringify(c.payload.tools).length : 0 }));
    return stats;
  } finally {
    cap.restore();
    globalThis.fetch = originalFetch;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] || "short";
  const overrides = {};
  if (process.argv[3]) overrides.thresholdTokens = Number(process.argv[3]);
  if (process.argv[4]) overrides.maxRecentMessages = Number(process.argv[4]);
  const stats = await runHarness(mode, overrides);
  console.log(JSON.stringify(stats, null, 2));
}
