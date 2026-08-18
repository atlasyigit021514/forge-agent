import { chatCompletion } from "./provider.js";
import { elideText } from "./context.js";

// Cheap token estimate: ~4 chars per token for mixed prose/code.
export function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

export function messagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(JSON.stringify(m)), 0);
}

// Find the last safe cut boundary in `rest` (non-system messages): after a
// complete assistant turn (no pending tool_calls), leaving keepRecent messages
// untouched. Always returns >= 1 so the original task message can be compacted
// only once there is enough recent context to carry the task.
function safeCutIndex(rest, keepRecent) {
  const maxCut = Math.max(1, rest.length - keepRecent);
  let cut = 1;
  for (let i = 1; i <= maxCut; i++) {
    const m = rest[i];
    if (m.role === "assistant" && !m.tool_calls) cut = i + 1;
  }
  return Math.min(Math.max(cut, 1), maxCut);
}

export async function summarizeMessages(config, messages) {
  const prompt = [
    {
      role: "system",
      content:
        "You are a lossless-but-dense conversation compactor. Produce a compact summary preserving: " +
        "who the user is and their preferences, the active task and its exact state, files/tools/skills involved, " +
        "verified facts (exact paths, URLs, names), open threads, and next steps. Use terse bullets. " +
        "No fluff. No politeness. No meta-commentary. Preserve exact identifiers verbatim."
    },
    {
      role: "user",
      content: `Compact the following conversation segment:\n\n${messages
        .map((m) => `${m.role.toUpperCase()}: ${m.content || JSON.stringify(m.tool_calls || "")}`)
        .join("\n")}`
    }
  ];
  const { message } = await chatCompletion(
    { ...config, agent: { ...config.agent, temperature: 0 } },
    prompt,
    []
  );
  return message.content;
}

// If the session is over the token threshold, summarize the oldest segment
// (safe boundaries only) into one cumulative [COMPACTED CONTEXT] system message
// and keep recent turns intact. The original system prompt is preserved.
// Returns { compacted, savedTokens, summaryTokens } or { compacted: false }.
export async function maybeCompact(config, session) {
  const opts = config.compaction;
  if (!opts?.enabled) return { compacted: false };
  try {
    const total = messagesTokens(session.messages);
    if (total <= opts.thresholdTokens) return { compacted: false };
    const keepRecent = Math.max(2, opts.keepRecent || 8);
    const system = session.messages.filter((m) => m.role === "system");
    const rest = session.messages.filter((m) => m.role !== "system");
    if (rest.length <= keepRecent) return { compacted: false };
    const cut = safeCutIndex(rest, keepRecent);
    if (cut < 1) return { compacted: false };
    const toCompact = rest.slice(0, cut);
    const recent = rest.slice(cut);
    // Fold any existing summary into the source so only ONE cumulative
    // [COMPACTED CONTEXT] block ever exists.
    const existing = system.filter((m) => m.content?.startsWith("[COMPACTED CONTEXT]"));
    const summarySource = [...existing, ...toCompact];
    const summary = await summarizeMessages(config, summarySource);
    const maxSummaryTokens = Math.max(200, opts.maxSummaryTokens || 2000);
    const capped = estimateTokens(summary) > maxSummaryTokens
      ? elideText(summary, maxSummaryTokens * 4)
      : summary;
    const nextSystem = [
      ...system.filter((m) => !m.content?.startsWith("[COMPACTED CONTEXT]")),
      { role: "system", content: `[COMPACTED CONTEXT]\n${capped}` }
    ];
    session.messages = [...nextSystem, ...recent];
    session.compactions = (session.compactions || 0) + 1;
    const savedTokens = total - messagesTokens(session.messages);
    return { compacted: true, savedTokens, summaryTokens: estimateTokens(capped), cut };
  } catch {
    // Compaction is best-effort; never crash the run because of it.
    return { compacted: false };
  }
}
