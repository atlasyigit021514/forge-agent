import { chatCompletion } from "./provider.js";
import { getToolDefinitions, executeTool, activateToolGroup } from "./tools.js";
import { skillsPrompt } from "./skills.js";
import { searchMemories } from "./memory.js";
import { maybeCompact } from "./compact.js";
import { buildModelMessages, elideText, mergeCompactedSummaries } from "./context.js";
import { compressToolResult, deduplicateToolResult, recordOptimization, virtualizeToolResult, recallContextPage } from "./optimization.js";
import { buildKernelMessages } from "./kernel.js";

const sessions = new Map();

const AUTONOMY_BOILERPLATE = "Operate autonomously until the task is genuinely complete. Inspect before editing, use relative workspace paths, verify changes, and report progress through concise assistant updates. Use persistent shell tools when interactive input is needed. Never expose secrets.";

function systemMessage(config, userText) {
  const parts = [config.agent.systemPrompt, `Workspace: ${config.workspace}`, skillsPrompt()];
  // Duplicate-context detection: the configured system prompt often already
  // carries the autonomy boilerplate; only append it if absent.
  if (!config.agent.systemPrompt.includes("Operate autonomously")) parts.push(AUTONOMY_BOILERPLATE);
  return parts.join("\n\n");
}

// Relevant memories are injected into the FIRST model call only; re-sending
// them every call taxes every turn. Key facts survive long runs via the
// compaction summary, which is instructed to preserve preferences.
function memoryBlock(config, userText) {
  const memoryTopK = config.context?.memoryTopK ?? 3;
  const memoryMaxItemChars = config.context?.memoryMaxItemChars ?? 400;
  const memories = searchMemories(userText, memoryTopK, 2).map((m) => `- ${elideText(m.text, memoryMaxItemChars)}`).join("\n");
  return memories ? `Relevant persistent memories:\n${memories}` : "";
}

function parseArgs(call) {
  try { return JSON.parse(call.function.arguments || "{}"); }
  catch { throw new Error(`Invalid arguments for ${call.function.name}`); }
}

function recordUsage(session, usage, attempts, latencyMs, toolCalls = 0) {
  const stats = session.stats ||= {
    calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
    totalTokens: 0, toolCalls: 0, retries: 0, latencyMs: 0
  };
  stats.calls++;
  stats.retries += Math.max(0, attempts - 1);
  stats.toolCalls += toolCalls;
  stats.latencyMs += latencyMs || 0;
  if (usage) {
    stats.inputTokens += usage.prompt_tokens || 0;
    stats.outputTokens += usage.completion_tokens || 0;
    stats.cachedInputTokens += usage.prompt_tokens_details?.cached_tokens || 0;
    stats.totalTokens += (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  }
}

export function sessionView(session, after = 0) {
  return { id: session.id, events: session.events.slice(after), eventCount: session.events.length, pending: session.pending ? { name: session.pending.name, args: session.pending.args } : null, status: session.status, done: session.done, turns: session.turns, createdAt: session.createdAt, stats: session.stats || null, optimizationStats: session.optimizationStats || null };
}

export function createSession(config, text, history = []) {
  // Drop a trailing history message identical to the new request (the UI
  // resends the last user message); sending it twice wastes tokens.
  const tail = history[history.length - 1];
  const effectiveHistory = tail && tail.content === text ? history.slice(0, -1) : history;
  const messages = [{ role: "system", content: systemMessage(config, text) }, ...effectiveHistory.slice(-30), { role: "user", content: text }];
  const memory = memoryBlock(config, text);
  const systemWithMemory = memory ? `${messages[0].content}\n\n${memory}` : messages[0].content;
  const id = crypto.randomUUID();
  const session = { id, originalTask: text, messages, systemWithMemory, events: [], listeners: new Set(), pending: null, done: false, cancelled: false, running: false, status: "queued", turns: 0, compactions: 0, stats: null, createdAt: new Date().toISOString() };
  sessions.set(id, session);
  emit(session, "status", { status: "queued", message: "Task queued" });
  return session;
}

function emit(session, type, data) {
  const item = { index: session.events.length, type, data, at: new Date().toISOString() };
  session.events.push(item);
  for (const listener of session.listeners) listener(item);
  return item;
}

function setStatus(session, status, message) {
  session.status = status;
  emit(session, "status", { status, message });
}

export function subscribeSession(id, listener) {
  const session = sessions.get(id);
  if (!session) throw new Error("Session not found");
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}

export function getSession(id) {
  const session = sessions.get(id);
  if (!session) throw new Error("Session not found");
  return session;
}

export function startSession(config, session) {
  queueMicrotask(() => runSession(config, session).catch((error) => {
    emit(session, "error", { message: error.message });
    session.done = true;
    setStatus(session, "failed", error.message);
  }));
  return sessionView(session);
}

export async function runSession(config, session) {
  if (session.running || session.done || session.pending) return sessionView(session);
  session.running = true;
  setStatus(session, "running", "Agent is working");
  try {
    while (!session.cancelled && !session.pending && session.turns < config.agent.maxTurns) {
      session.turns++;
      emit(session, "progress", { phase: "model", message: `Thinking · turn ${session.turns}`, turn: session.turns });
      // Bounded-context layer: compact the overflow (LLM summary) when the
      // working history crosses the threshold, then send only a recent window.
      await maybeCompact(config, session);
      const modelMessages = config.optimization?.tokenKernel?.enabled
        ? buildKernelMessages(session, config)
        : buildModelMessages(session, config);
      const { message, usage, attempts, latencyMs } = await chatCompletion(config, modelMessages, getToolDefinitions(config, session), ({ attempt, delay, error }) => {
        emit(session, "progress", { phase: "retry", message: `Model request failed; retry ${attempt} in ${delay} ms`, attempt, error });
      }, (content) => emit(session, "assistant_delta", { content, turn: session.turns }));
      session.messages.push(message);
      const calls = message.tool_calls || [];
      recordUsage(session, usage, attempts, latencyMs, calls.length);
      if (attempts > 1) emit(session, "progress", { phase: "recovered", message: `Model request recovered after ${attempts} attempts` });
      if (message.content) emit(session, "assistant", { content: message.content, usage, streamed: true, turn: session.turns });
      if (!calls.length) { session.done = true; setStatus(session, "completed", "Task completed"); break; }
      for (const call of calls) {
        if (session.cancelled) break;
        const name = call.function.name, args = parseArgs(call);
        emit(session, "tool_request", { id: call.id, name, args });
        await perform(config, session, call, name, args);
      }
      session.messages = mergeCompactedSummaries(session.messages);
    }
    if (session.cancelled) { session.done = true; setStatus(session, "cancelled", "Stopped by user"); }
    else if (!session.pending && !session.done && session.turns >= config.agent.maxTurns) {
      emit(session, "error", { message: `Maximum of ${config.agent.maxTurns} turns reached. Increase Max turns in Settings to allow longer autonomous runs.` });
      session.done = true; setStatus(session, "limit", "Turn limit reached");
    }
  } finally { session.running = false; }
  if (session.done) emit(session, "stats", session.stats || { calls: 0 });
  return sessionView(session);
}

async function perform(config, session, call, name, args) {
  emit(session, "progress", { phase: "tool", message: `Running ${name}` });
  const maxChars = config.context?.maxToolResultChars ?? 8000;
  try {
    const isRecall = name === "context_recall";
    const isGroupLoad = name === "load_tool_group";
    const result = isRecall
      ? recallContextPage(session, args.pageId, args.startChar, args.endChar)
      : isGroupLoad
        ? activateToolGroup(session, args.group)
        : await executeTool(config, name, args);
    const raw = JSON.stringify(result);
    const paged = isRecall || isGroupLoad
      ? { content: raw, savedChars: 0, virtualized: false }
      : virtualizeToolResult(session, raw, config.optimization?.contextVirtualMemory);
    const bounded = paged.virtualized ? paged.content : elideText(raw, maxChars);
    const compressed = paged.virtualized
      ? { content: bounded, savedChars: 0, compressed: false }
      : await compressToolResult(bounded, config.optimization?.semanticToolCompression);
    const optimized = deduplicateToolResult(session, compressed.content, config.optimization?.deduplicateToolResults);
    recordOptimization(session, {
      ...optimized,
      virtualized: paged.virtualized,
      pageCount: paged.pageCount,
      recalled: isRecall,
      compressed: compressed.compressed,
      savedChars: paged.savedChars + compressed.savedChars + optimized.savedChars
    });
    const content = optimized.content;
    session.messages.push({ role: "tool", tool_call_id: call.id, content });
    emit(session, "tool_result", { id: call.id, name, result });
  } catch (error) {
    session.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: error.message }) });
    emit(session, "tool_result", { id: call.id, name, error: error.message });
  }
}

export function cancelSession(id) {
  const session = getSession(id);
  session.cancelled = true;
  session.pending = null;
  setStatus(session, "stopping", "Stopping after the current operation");
  return sessionView(session);
}
