import { runHarness } from "./harness.mjs";

const baseline = await runHarness("long", { contextVirtualMemory: false, thresholdTokens: 1_000_000 });
const cvm = await runHarness("long", { contextVirtualMemory: true, thresholdTokens: 1_000_000 });
const saved = baseline.inputTokens - cvm.inputTokens;

console.log(JSON.stringify({
  experiment: "Context Virtual Memory / deterministic long-run harness",
  baselineInputTokens: baseline.inputTokens,
  cvmInputTokens: cvm.inputTokens,
  savedInputTokens: saved,
  savedPercent: baseline.inputTokens ? Number((saved * 100 / baseline.inputTokens).toFixed(2)) : 0,
  baselinePeakContextTokens: baseline.peakContextTokens,
  cvmPeakContextTokens: cvm.peakContextTokens,
  cvmOptimization: cvm.optimization
}, null, 2));
