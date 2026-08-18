import { createHash } from "node:crypto";

function hash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const COMMON_TERMS = new Set([
  "this", "that", "with", "from", "have", "will", "true", "false", "null", "undefined",
  "const", "function", "return", "string", "object", "array", "number", "export", "import",
  "icin", "olan", "olarak", "gibi", "daha", "veya", "ama", "bir", "the", "and", "for"
]);

function salientTerms(text, limit = 8) {
  const counts = new Map();
  for (const raw of text.match(/[\p{L}\p{N}_.$/-]{4,}/gu) || []) {
    const term = raw.toLowerCase();
    if (COMMON_TERMS.has(term) || /^\d+$/.test(term)) continue;
    counts.set(term, (counts.get(term) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

function splitPages(text, pageChars) {
  const pages = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + pageChars);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > offset + Math.floor(pageChars * 0.6)) end = newline + 1;
    }
    pages.push({ content: text.slice(offset, end), startChar: offset, endChar: end });
    offset = end;
  }
  return pages;
}

// Context Virtual Memory (CVM): large tool results are retained byte-for-byte
// in session-local pages while the model initially receives a cheap lexical
// map. The context_recall tool is exposed only after pages exist, so ordinary
// runs pay neither its schema tokens nor paging overhead.
export function virtualizeToolResult(session, content, options = {}) {
  const minChars = Math.max(1000, options.minChars ?? 6000);
  if (options.enabled === false || content.length < minChars) {
    return { content, savedChars: 0, virtualized: false };
  }
  const pageChars = Math.max(800, options.pageChars ?? 2400);
  const previewChars = Math.max(80, options.previewChars ?? 320);
  const resultId = hash(content);
  const pages = splitPages(content, pageChars);
  const store = session.contextPages ||= new Map();
  const maxSessionChars = Math.max(minChars, options.maxSessionChars ?? 2_000_000);
  const additionalChars = pages.reduce((sum, page, index) => {
    return sum + (store.has(`${resultId}:${index + 1}`) ? 0 : page.content.length);
  }, 0);
  if ((session.contextPageChars || 0) + additionalChars > maxSessionChars) {
    return { content, savedChars: 0, virtualized: false, capacityExceeded: true };
  }
  const createdPageIds = [];
  const descriptors = pages.map((page, index) => {
    const pageId = `${resultId}:${index + 1}`;
    if (!store.has(pageId)) createdPageIds.push(pageId);
    store.set(pageId, { ...page, pageId, resultId, index: index + 1, total: pages.length });
    const sample = page.content.slice(0, previewChars).replace(/\s+/g, " ");
    return {
      pageId,
      chars: page.content.length,
      range: [page.startChar, page.endChar],
      terms: salientTerms(page.content),
      sample
    };
  });
  const capsule = JSON.stringify({
    context_virtual_memory: {
      resultId,
      originalChars: content.length,
      pageCount: pages.length,
      instruction: "Use context_recall with a pageId only when exact details from that page are needed.",
      pages: descriptors
    }
  });
  if (capsule.length >= content.length) {
    for (const pageId of createdPageIds) store.delete(pageId);
    return { content, savedChars: 0, virtualized: false };
  }
  session.contextPageChars = (session.contextPageChars || 0) + additionalChars;
  return { content: capsule, savedChars: content.length - capsule.length, virtualized: true, resultId, pageCount: pages.length };
}

export function recallContextPage(session, pageId, startChar, endChar) {
  const page = session.contextPages?.get(pageId);
  if (!page) throw new Error(`Unknown or expired context page: ${pageId}`);
  const start = Math.max(0, Number.isInteger(startChar) ? startChar : 0);
  const end = Math.min(page.content.length, Number.isInteger(endChar) ? endChar : page.content.length);
  if (end <= start) throw new Error("endChar must be greater than startChar");
  return {
    pageId,
    resultId: page.resultId,
    page: page.index,
    totalPages: page.total,
    slice: [start, end],
    content: page.content.slice(start, end)
  };
}

// Lossless session deduplication for large, repeated tool results. The first
// occurrence remains byte-for-byte intact; later occurrences become a stable
// reference. System/user/assistant content never enters this pipeline.
export function deduplicateToolResult(session, content, options = {}) {
  if (options.enabled === false || content.length < (options.minChars ?? 1200)) {
    return { content, savedChars: 0, deduplicated: false };
  }
  const digest = hash(content);
  const seen = session.toolResultHashes ||= new Map();
  const prior = seen.get(digest);
  if (!prior) {
    seen.set(digest, { turn: session.turns, chars: content.length });
    return { content, savedChars: 0, deduplicated: false, digest };
  }
  const reference = JSON.stringify({
    repeated_tool_result: digest,
    original_turn: prior.turn,
    original_chars: prior.chars
  });
  return { content: reference, savedChars: Math.max(0, content.length - reference.length), deduplicated: true, digest };
}

// Optional LLMLingua/Headroom-compatible sidecar hook. It is deliberately
// restricted to tool output and disabled by default: prompts and instructions
// are never rewritten. The endpoint contract is intentionally tiny:
// POST { text, targetRatio } -> { compressedText }.
export async function compressToolResult(content, options = {}) {
  if (!options.enabled || !options.endpoint || content.length < (options.minChars ?? 12000)) {
    return { content, savedChars: 0, compressed: false };
  }
  try {
    const response = await fetch(options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {})
      },
      body: JSON.stringify({ text: content, targetRatio: options.targetRatio ?? 0.5 }),
      signal: AbortSignal.timeout(Math.max(1000, options.timeoutMs ?? 30000))
    });
    if (!response.ok) throw new Error(`compressor returned ${response.status}`);
    const body = await response.json();
    const candidate = body.compressedText;
    // Inflation guard: malformed or larger output is discarded.
    if (typeof candidate !== "string" || !candidate || candidate.length >= content.length) {
      return { content, savedChars: 0, compressed: false };
    }
    return { content: candidate, savedChars: content.length - candidate.length, compressed: true };
  } catch (error) {
    if (options.failOpen === false) throw error;
    return { content, savedChars: 0, compressed: false, error: error.message };
  }
}

export function recordOptimization(session, result) {
  const stats = session.optimizationStats ||= {
    savedChars: 0, deduplicatedResults: 0, compressedResults: 0,
    virtualizedResults: 0, virtualPages: 0, recalledPages: 0
  };
  stats.savedChars += result.savedChars || 0;
  if (result.deduplicated) stats.deduplicatedResults++;
  if (result.compressed) stats.compressedResults++;
  if (result.virtualized) {
    stats.virtualizedResults++;
    stats.virtualPages += result.pageCount || 0;
  }
  if (result.recalled) stats.recalledPages++;
}
