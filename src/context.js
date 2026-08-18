// Context budget manager: builds the trimmed message window actually sent to
// the model. session.messages remains the full working history (UI replay,
// compaction decisions); only this window is transmitted each call.
//
// Structure sent to the model:
//   SYSTEM (all system messages: prompt + any [COMPACTED CONTEXT] summary)
//   + FIRST USER MESSAGE (task statement, preserved if windowed out)
//   + RECENT WINDOW (maxRecentMessages, cut at a safe turn boundary)

export function elideText(text, maxChars = 8000) {
  if (!text || text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.max(40, maxChars - head - 60);
  return `${text.slice(0, head)}\n…[TRUNCATED: ${text.length - maxChars} chars removed]…\n${text.slice(-tail)}`;
}

// Find the window start index within `rest` (non-system messages) such that
// the window is self-contained: it must begin at a user message or at an
// assistant message (its tool results, if any, follow within the window).
// Cutting at a bare tool message would orphan its assistant.
export function windowStart(rest, maxRecent) {
  const len = rest.length;
  if (len <= maxRecent) return 0;
  const min = Math.max(1, len - maxRecent);
  // Prefer the largest window that fits the budget: the smallest safe start
  // index >= min. Cap the search so we never cut down to just the final
  // message (a degenerate, context-starved window).
  const max = Math.max(min, len - 2);
  for (let i = min; i <= max; i++) {
    if (rest[i]?.role === "assistant") return i;
  }
  for (let i = min - 1; i >= 1; i--) {
    if (rest[i]?.role === "assistant") return i;
  }
  return 0;
}

export function buildModelMessages(session, config = {}) {
  const maxRecent = Math.max(6, config.context?.maxRecentMessages ?? 24);
  const messages = session.messages || [];
  let system = messages.filter((m) => m.role === "system");
  // Memories ride the system message on the first call only; later calls use
  // the lean base system (key facts survive via compaction summaries).
  if (session.turns <= 1 && session.systemWithMemory && session.systemWithMemory !== system[0]?.content) {
    system = [{ role: "system", content: session.systemWithMemory }, ...system.slice(1)];
  }
  const rest = messages.filter((m) => m.role !== "system");
  if (rest.length <= maxRecent) return [...system, ...rest];
  const start = windowStart(rest, maxRecent);
  const window = rest.slice(start);
  // Preserve the original task statement if the window starts past it.
  if (start >= 1 && rest[0]?.role === "user" && !window.includes(rest[0])) {
    window.unshift(rest[0]);
  }
  return [...system, ...window];
}

// Collapse repeated [COMPACTED CONTEXT] system messages into a single one by
// keeping only the newest (they are built cumulatively by maybeCompact).
export function mergeCompactedSummaries(messages) {
  const compacted = [];
  const kept = [];
  for (const m of messages) {
    if (m.role === "system" && m.content?.startsWith("[COMPACTED CONTEXT]")) {
      compacted.push(m.content);
    } else {
      kept.push(m);
    }
  }
  if (!compacted.length) return messages;
  return [{ role: "system", content: compacted.join("\n\n") }, ...kept];
}
