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

function initialToolGroups(text) {
  const value = String(text || "").toLowerCase();
  const groups = new Set();
  if (/youtube|browser|chrome|discord|roblox|studio|\bopen\b|\baç|click|tıkla|screen|ekran|uygulama|\bapp\b|video|web|site|foreground|background|arka plan|ön plan/.test(value)) groups.add("computer");
  if (/terminal|shell|powershell|\bkomut|\bcommand|\bnpm\b|\bpip\b|\bgit\b/.test(value)) groups.add("shell");
  return groups;
}

function isSimpleDesktopTask(text) {
  const value = String(text || "").toLowerCase();
  return value.length < 300 && /(youtube|browser|chrome|discord|\bopen\b|\baç|video|web|site)/.test(value) && !/(build|create|edit|change|develop|kodla|oluştur|değiştir)/.test(value);
}

function isSimpleShellTask(text) {
  const value = String(text || "").toLocaleLowerCase("tr-TR");
  return value.length < 600 && /(?:shell_run|run\s+(?:this|the)\s+(?:exact\s+)?command|execute\s+(?:this|the)\s+(?:exact\s+)?command|komutu\s+çalıştır|komut\s+çalıştır)/.test(value) && !/(?:build|develop|implement|refactor|debug|oluştur|geliştir|düzelt)/.test(value);
}

function requestedComputerMode(text) {
  const value = String(text || "").toLocaleLowerCase("tr-TR");
  if (/(?:foreground|ön\s*plan|on\s*plan|öne\s*getir|one\s*getir|önüme\s*getir|onume\s*getir|karşıma\s*(?:getir|çıkar)|show\s+(?:it|me)|watch\s+(?:it|this))/.test(value)) return "foreground";
  return "background";
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter((key) => !["observationId", "timeoutMs", "verifyDelayMs"].includes(key)).map((key) => [key, stableValue(value[key])]));
  return value;
}

function toolAttemptKey(name, args) {
  return `${name}:${JSON.stringify(stableValue(args))}`;
}

function isComputerTool(name) {
  return name === "computer_focus" || name === "roblox_project" || name.startsWith("computer_");
}

function prepareToolArgs(session, name, args) {
  if (!isComputerTool(name)) return args;
  if (name === "computer_windows") return args;
  return { ...args, mode: session.computerMode };
}

function blockedToolResult(session, name, args) {
  const key = toolAttemptKey(name, args);
  const attempt = session.toolAttempts.get(key);
  if (!attempt) return null;
  if (attempt.failures >= 2) return { ok: false, rejected: "repeated_failed_action", message: "This action already failed twice. Choose a different tool or method; do not retry it." };
  if (name === "computer_observe" && attempt.unchanged >= 2) return { ok: false, rejected: "unchanged_observation_loop", message: "The same window state was already observed three times. Act with computer_find_and_act/computer_interact or stop; do not observe it again." };
  return null;
}

function recordToolAttempt(session, name, args, result, error = null) {
  const key = toolAttemptKey(name, args);
  const prior = session.toolAttempts.get(key) || { failures: 0, unchanged: 0, imageHash: null };
  if (error || result?.ok === false || result?.rejected) prior.failures++;
  else prior.failures = 0;
  const imageHash = result?.imageHash || result?.observation?.imageHash;
  if (imageHash && imageHash === prior.imageHash) prior.unchanged++;
  else if (imageHash) prior.unchanged = 0;
  if (imageHash) prior.imageHash = imageHash;
  session.toolAttempts.set(key, prior);
}

function systemMessage(config, userText) {
  const parts = [config.agent.systemPrompt, `Workspace: ${config.workspace}`, skillsPrompt(userText)];
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
  return { id: session.id, events: session.events.slice(after), eventCount: session.events.length, pending: session.pending ? { name: session.pending.name, prompt: session.pending.args.prompt, secret: Boolean(session.pending.args.secret), shellSessionId: session.pending.args.shellSessionId || null } : null, status: session.status, done: session.done, turns: session.turns, createdAt: session.createdAt, stats: session.stats || null, optimizationStats: session.optimizationStats || null };
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
  const fastComputerTask = isSimpleDesktopTask(text);
  const fastShellTask = isSimpleShellTask(text);
  const fastOperationalTask = fastComputerTask || fastShellTask;
  const session = { id, originalTask: text, messages, systemWithMemory, events: [], listeners: new Set(), pending: null, done: false, cancelled: false, running: false, status: "queued", turns: 0, turnLimit: config.agent.maxTurns, fastComputerTask, fastShellTask, thinkingMode: fastOperationalTask ? "none" : config.agent.thinkingMode, computerMode: requestedComputerMode(text), activeToolGroups: initialToolGroups(text), toolAttempts: new Map(), compactions: 0, stats: null, createdAt: new Date().toISOString() };
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
  const continueWhenIdle = () => {
    if (session.running) return setTimeout(continueWhenIdle, 10);
    runSession(config, session).catch((error) => {
      emit(session, "error", { message: error.message });
      session.done = true;
      setStatus(session, "failed", error.message);
    });
  };
  setTimeout(continueWhenIdle, 0);
  return sessionView(session);
}

export async function runSession(config, session) {
  if (session.running || session.done || session.pending) return sessionView(session);
  session.running = true;
  setStatus(session, "running", "Agent is working");
  try {
    while (!session.cancelled && !session.pending && session.turns < session.turnLimit) {
      session.turns++;
      emit(session, "progress", { phase: "model", message: `Thinking · turn ${session.turns}`, turn: session.turns });
      // Bounded-context layer: compact the overflow (LLM summary) when the
      // working history crosses the threshold, then send only a recent window.
      await maybeCompact(config, session);
      const modelMessages = config.optimization?.tokenKernel?.enabled
        ? buildKernelMessages(session, config)
        : buildModelMessages(session, config);
      const modelConfig = { ...config, agent: { ...config.agent, thinkingMode: session.thinkingMode } };
      const { message, usage, attempts, latencyMs } = await chatCompletion(modelConfig, modelMessages, getToolDefinitions(config, session), ({ attempt, delay, error }) => {
        emit(session, "progress", { phase: "retry", message: `Model request failed; retry ${attempt} in ${delay} ms`, attempt, error });
      }, (content) => emit(session, "assistant_delta", { content, turn: session.turns }));
      session.messages.push(message);
      const calls = message.tool_calls || [];
      recordUsage(session, usage, attempts, latencyMs, calls.length);
      if (attempts > 1) emit(session, "progress", { phase: "recovered", message: `Model request recovered after ${attempts} attempts` });
      if (message.content) emit(session, "assistant", { content: message.content, usage, streamed: true, turn: session.turns });
      if (!calls.length) { session.done = true; setStatus(session, "completed", "Task completed"); break; }
      for (const call of calls) {
        if (session.cancelled || session.pending) break;
        const name = call.function.name, args = parseArgs(call);
        emit(session, "tool_request", { id: call.id, name, args });
        await perform(config, session, call, name, args);
      }
      if (session.autoCompletion && !session.pending && !session.cancelled) {
        const content = session.autoCompletion;
        session.messages.push({ role: "assistant", content });
        emit(session, "assistant", { content, streamed: false, turn: session.turns, automatic: true });
        session.done = true;
        setStatus(session, "completed", "Task completed");
        break;
      }
      session.messages = mergeCompactedSummaries(session.messages);
    }
    if (session.cancelled) { session.done = true; setStatus(session, "cancelled", "Stopped by user"); }
    else if (!session.pending && !session.done && session.turns >= session.turnLimit) {
      emit(session, "error", { message: `Maximum of ${session.turnLimit} turns reached for this task.` });
      session.done = true; setStatus(session, "limit", "Turn limit reached");
    }
  } finally { session.running = false; }
  if (session.done) emit(session, "stats", session.stats || { calls: 0 });
  return sessionView(session);
}

async function perform(config, session, call, name, args) {
  emit(session, "progress", { phase: "tool", message: `Running ${name}` });
  const maxChars = config.context?.maxToolResultChars ?? 8000;
  const effectiveArgs = prepareToolArgs(session, name, args);
  try {
    if (name === "request_user_input") {
      session.pending = { callId: call.id, name, args, createdAt: new Date().toISOString() };
      emit(session, "input_request", { prompt: args.prompt, secret: Boolean(args.secret), shellSessionId: args.shellSessionId || null });
      setStatus(session, "waiting", args.prompt);
      return;
    }
    if (name === "computer_focus" && session.computerMode !== "foreground") {
      const result = { ok: false, rejected: "foreground_not_requested", message: "The user did not request foreground mode." };
      session.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      emit(session, "tool_result", { id: call.id, name, result });
      return;
    }
    const blocked = blockedToolResult(session, name, effectiveArgs);
    if (blocked) {
      session.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(blocked) });
      emit(session, "tool_result", { id: call.id, name, result: blocked });
      return;
    }
    const isRecall = name === "context_recall";
    const isGroupLoad = name === "load_tool_group";
    const isInteractiveState = name === "computer_observe" || name === "computer_windows";
    const result = isRecall
      ? recallContextPage(session, args.pageId, args.startChar, args.endChar)
      : isGroupLoad
        ? activateToolGroup(session, args.group)
        : await executeTool(config, name, effectiveArgs);
    recordToolAttempt(session, name, effectiveArgs, result);
    const raw = JSON.stringify(result);
    const paged = isRecall || isGroupLoad || isInteractiveState
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
    if (result?.taskComplete === true && result?.ok !== false && typeof result.summary === "string") session.autoCompletion = session.autoCompletion ? `${session.autoCompletion}\n${result.summary}` : result.summary;
    if ((name === "shell_run" || name === "shell_wait") && result?.needsInput && result?.id) {
      const prompt = result.prompt || "The command is waiting for input.";
      session.pending = { callId: null, name: "shell_input", args: { prompt, shellSessionId: result.id, secret: /password|passcode|otp|token|şifre|parola|kod/i.test(prompt) }, createdAt: new Date().toISOString() };
      emit(session, "input_request", { prompt, secret: session.pending.args.secret, shellSessionId: result.id });
      setStatus(session, "waiting", prompt);
    }
  } catch (error) {
    recordToolAttempt(session, name, effectiveArgs, null, error);
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

export async function resumeSession(config, id, input) {
  const session = getSession(id);
  if (!session.pending) throw new Error("Session is not waiting for user input");
  const pending = session.pending;
  const value = String(input ?? "");
  let deliveredToShell = false;
  let resumedShellState = null;
  if (pending.args.shellSessionId) {
    await executeTool(config, "shell_write", { sessionId: pending.args.shellSessionId, input: value, appendNewline: true });
    deliveredToShell = true;
  }
  if (pending.callId) {
    session.messages.push({ role: "tool", tool_call_id: pending.callId, content: JSON.stringify({ userResponse: value, deliveredToShell }) });
  } else {
    if (deliveredToShell) resumedShellState = await executeTool(config, "shell_wait", { sessionId: pending.args.shellSessionId, timeoutMs: 10000, idleMs: 350 });
    session.messages.push({ role: "user", content: `The requested shell input was delivered to session ${pending.args.shellSessionId}. Current shell state: ${JSON.stringify(resumedShellState)}` });
  }
  session.pending = null;
  emit(session, "input_received", { secret: Boolean(pending.args.secret), deliveredToShell, shellState: resumedShellState });
  if (!pending.callId && resumedShellState?.needsInput) {
    const prompt = resumedShellState.prompt || "The command is waiting for more input.";
    session.pending = { callId: null, name: "shell_input", args: { prompt, shellSessionId: pending.args.shellSessionId, secret: Boolean(pending.args.secret) }, createdAt: new Date().toISOString() };
    emit(session, "input_request", { prompt, secret: session.pending.args.secret, shellSessionId: pending.args.shellSessionId });
    setStatus(session, "waiting", prompt);
    return sessionView(session);
  }
  if (!pending.callId && session.fastShellTask && resumedShellState && (resumedShellState.output || !resumedShellState.running)) {
    const output = String(resumedShellState.output || "").trim();
    const content = output ? `Input delivered to shell PID ${resumedShellState.pid}.\n\n${output}` : `Input delivered to shell PID ${resumedShellState.pid}; process exited with code ${resumedShellState.exitCode}.`;
    session.messages.push({ role: "assistant", content });
    emit(session, "assistant", { content, streamed: false, turn: session.turns, automatic: true });
    session.done = true;
    setStatus(session, "completed", "Task completed");
    emit(session, "stats", session.stats || { calls: 0 });
    return sessionView(session);
  }
  setStatus(session, "queued", deliveredToShell ? "Input delivered; resuming task" : "Input received; resuming task");
  const continueWhenIdle = () => {
    if (session.running) return setTimeout(continueWhenIdle, 10);
    runSession(config, session).catch((error) => {
      emit(session, "error", { message: error.message });
      session.done = true;
      setStatus(session, "failed", error.message);
    });
  };
  setTimeout(continueWhenIdle, 0);
  return sessionView(session);
}
