import { runHarness } from "./harness.mjs";

const overrides = { thresholdTokens: 1_000_000, contextVirtualMemory: true };
const baseline = await runHarness("long", { ...overrides, tokenKernel: false });
const kernel = await runHarness("long", { ...overrides, tokenKernel: true });
const saved = baseline.inputTokens - kernel.inputTokens;

console.log(JSON.stringify({
  experiment: "Token Kernel / deterministic 13-call trace",
  warning: "Measures payload reduction, not real-model task quality.",
  baselineInputTokens: baseline.inputTokens,
  kernelInputTokens: kernel.inputTokens,
  savedInputTokens: saved,
  savedPercent: Number((saved * 100 / baseline.inputTokens).toFixed(2)),
  baselinePeakContextTokens: baseline.peakContextTokens,
  kernelPeakContextTokens: kernel.peakContextTokens,
  kernelPerCall: kernel.perCall
}, null, 2));
