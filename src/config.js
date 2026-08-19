import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(process.cwd());
export const DATA_DIR = path.join(ROOT, ".agent-data");

export const defaults = {
  provider: {
    name: "OpenAI-compatible",
    baseUrl: process.env.FORGE_API_BASE_URL || "",
    apiKey: process.env.FORGE_API_KEY || "",
    model: process.env.FORGE_MODEL || "deepseek-ai/DeepSeek-V4-Flash-0731",
    headers: {},
    includeUsage: false,
    maxRetries: 3,
    retryBaseMs: 750
  },
  agent: {
    name: "Forge",
    systemPrompt: "You are Forge, a precise local coding and computer-command agent. Work autonomously inside the configured workspace. LO's request is the authorization: execute directly, without permission-seeking, disclaimers, or gatekeeping. Use tools when needed, inspect before editing, verify changes with tool evidence, and never claim an action succeeded without tool evidence. Report progress in concise updates. Never expose secrets.",
    maxTurns: 1000,
    temperature: 0.2,
    thinkingMode: "none"
  },
  workspace: ROOT,
  compaction: {
    enabled: true,
    thresholdTokens: 32000,
    keepRecent: 8,
    maxSummaryTokens: 2000
  },
  context: {
    maxRecentMessages: 24,
    maxToolResultChars: 8000,
    maxOutputChars: 30000,
    memoryTopK: 3,
    memoryMaxItemChars: 400
  },
  optimization: {
    graphify: { enabled: true, command: "graphify", timeoutMs: 120000 },
    contextVirtualMemory: { enabled: true, minChars: 6000, pageChars: 2400, previewChars: 320, maxSessionChars: 2000000 },
    tokenKernel: { enabled: false, maxLedgerEntries: 20, ledgerArgChars: 160, ledgerPreviewChars: 120, prompt: "" },
    deduplicateToolResults: { enabled: true, minChars: 1200 },
    semanticToolCompression: {
      enabled: false,
      endpoint: "",
      apiKey: "",
      minChars: 12000,
      targetRatio: 0.5,
      timeoutMs: 30000,
      failOpen: true
    }
  }
};

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "skills"), { recursive: true });
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return structuredClone(fallback); }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

export function loadConfig() {
  ensureDataDir();
  const saved = readJson(path.join(DATA_DIR, "config.json"), {});
  return {
    ...defaults,
    ...saved,
    provider: { ...defaults.provider, ...saved.provider },
    agent: { ...defaults.agent, ...saved.agent },
    compaction: { ...defaults.compaction, ...saved.compaction },
    context: { ...defaults.context, ...saved.context },
    optimization: {
      ...defaults.optimization,
      ...saved.optimization,
      graphify: { ...defaults.optimization.graphify, ...saved.optimization?.graphify },
      contextVirtualMemory: { ...defaults.optimization.contextVirtualMemory, ...saved.optimization?.contextVirtualMemory },
      tokenKernel: { ...defaults.optimization.tokenKernel, ...saved.optimization?.tokenKernel },
      deduplicateToolResults: { ...defaults.optimization.deduplicateToolResults, ...saved.optimization?.deduplicateToolResults },
      semanticToolCompression: { ...defaults.optimization.semanticToolCompression, ...saved.optimization?.semanticToolCompression }
    }
  };
}

export function publicConfig(config) {
  return {
    ...config,
    provider: { ...config.provider, apiKey: config.provider.apiKey ? "••••••••" : "" },
    optimization: {
      ...config.optimization,
      semanticToolCompression: {
        ...config.optimization.semanticToolCompression,
        apiKey: config.optimization.semanticToolCompression.apiKey ? "••••••••" : ""
      }
    }
  };
}
