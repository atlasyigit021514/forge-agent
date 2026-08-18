// Real-provider benchmark: runs the standard task through the actual
// configured endpoint and reports per-call token usage from the provider.
// Small, bounded task to keep spend minimal.
import { loadConfig } from "../src/config.js";
import { createSession, runSession } from "../src/agent.js";
import { captureFetch, summarize } from "./measure.js";
import { STANDARD_TASK } from "./harness.mjs";

const config = loadConfig();
const kernelEnabled = process.argv.includes("--kernel");
const taskArgument = process.argv.find((item) => item.startsWith("--task="));
const benchmarkTask = taskArgument ? taskArgument.slice("--task=".length) : STANDARD_TASK;
config.optimization.tokenKernel.enabled = kernelEnabled;
// DeepInfra supports usage in the final streaming chunk. This runtime-only
// override does not modify the user's saved provider configuration.
if (process.argv.includes("--usage")) config.provider.includeUsage = true;
const cap = captureFetch();
try {
  const session = createSession(config, benchmarkTask);
  const started = Date.now();
  await runSession(config, session);
  const wallMs = Date.now() - started;
  const stats = summarize(cap.calls, kernelEnabled ? "real-token-kernel" : "real-baseline");
  stats.wallMs = wallMs;
  stats.finalTurns = session.turns;
  stats.status = session.status;
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
  stats.finalAnswer = lastAssistant?.content || null;
  // provider.js parses usage from the final SSE chunk into session telemetry;
  // captureFetch cannot JSON-parse an entire event stream as one response.
  if (session.stats?.totalTokens > 0) {
    stats.inputTokens = session.stats.inputTokens;
    stats.outputTokens = session.stats.outputTokens;
    stats.totalTokens = stats.inputTokens + stats.outputTokens;
    stats.providerReported = true;
  }
  stats.sessionTelemetry = session.stats || null;
  stats.optimization = session.optimizationStats || null;
  stats.perCall = cap.calls.map((c, i) => ({
    i: i + 1,
    inputTokens: c.inputTokens,
    providerPromptTokens: c.usage?.prompt_tokens ?? null,
    providerCachedTokens: c.usage?.prompt_tokens_details?.cached_tokens ?? null,
    sentMessages: c.payload?.messages?.length,
    systemChars: c.payload?.messages?.[0]?.content?.length ?? 0,
    toolsChars: c.payload?.tools ? JSON.stringify(c.payload.tools).length : 0
  }));
  console.log(JSON.stringify(stats, null, 2));
} finally {
  cap.restore();
}
