import path from "node:path";
import { DATA_DIR, readJson, writeJson } from "./config.js";

const file = path.join(DATA_DIR, "memory.json");
const DEFAULT_TOP_K = 5;

export function getMemories() {
  return readJson(file, []);
}

export function remember(text, tags = []) {
  const memories = getMemories();
  const item = { id: crypto.randomUUID(), text, tags, createdAt: new Date().toISOString() };
  memories.unshift(item);
  writeJson(file, memories.slice(0, 500));
  return item;
}

export function forget(id) {
  const next = getMemories().filter((item) => item.id !== id);
  writeJson(file, next);
  return { removed: id };
}

// Simple tokenizer: alphanumeric terms of length >= 3. Short or empty queries
// ("hi", "ok", "!") match nothing instead of matching every memory.
function tokenize(query) {
  return String(query || "").toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 3);
}

// Scored retrieval: rank by number of matched terms, break ties by recency
// (memory.json is newest-first). Deterministic, no LLM cost.
// minScore >= 2 filters incidental single-term hits when injecting context.
export function searchMemories(query = "", topK = DEFAULT_TOP_K, minScore = 1) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const scored = getMemories()
    .map((item, index) => {
      const hay = `${item.text} ${item.tags.join(" ")}`.toLowerCase();
      let score = 0;
      for (const term of terms) if (hay.includes(term)) score++;
      return { item, score, index };
    })
    .filter((x) => x.score >= Math.max(1, minScore))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, Math.max(1, topK)).map((x) => x.item);
}
