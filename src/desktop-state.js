import crypto from "node:crypto";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_LIMIT = 48;

export function windowKey(window) {
  if (!window) return "unknown";
  return `${Number(window.processId) || 0}:${String(window.handle || 0)}`;
}

export function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("tr-TR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function observationFingerprint(observation) {
  if (observation?.imageHash) return `image:${observation.imageHash}`;
  const controls = (observation?.controls || []).map((control) => {
    const bounds = control.bounds || {};
    return [normalizeText(control.name), control.type || "", bounds.x || 0, bounds.y || 0, bounds.width || 0, bounds.height || 0].join(":");
  });
  return crypto.createHash("sha256").update(controls.join("\n")).digest("hex");
}

export function observationsChanged(before, after) {
  if (!before || !after) return false;
  return observationFingerprint(before) !== observationFingerprint(after);
}

export function findControl(controls, requestedText) {
  const needle = normalizeText(requestedText);
  if (!needle) return { match: null, candidates: [], reason: "control_text_required" };
  const ranked = (controls || []).map((control) => {
    const name = normalizeText(control.name);
    let score = 0;
    if (name === needle) score = 100;
    else if (name.startsWith(needle) || needle.startsWith(name)) score = 90;
    else if (name.includes(needle) || needle.includes(name)) score = 80;
    else {
      const wanted = new Set(needle.split(" ").filter(Boolean));
      const actual = new Set(name.split(" ").filter(Boolean));
      let common = 0;
      for (const token of wanted) if (actual.has(token)) common++;
      score = wanted.size ? Math.round((common / wanted.size) * 70) : 0;
    }
    return { control, score };
  }).filter((item) => item.score >= 50).sort((a, b) => b.score - a.score || a.control.index - b.control.index);
  if (!ranked.length) return { match: null, candidates: [], reason: "control_not_found" };
  const tied = ranked.filter((item) => item.score === ranked[0].score);
  if (tied.length > 1) return { match: null, candidates: tied.slice(0, 8).map((item) => item.control), reason: "control_ambiguous" };
  return { match: ranked[0].control, candidates: ranked.slice(0, 8).map((item) => item.control), reason: null };
}

export class ObservationStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, limit = DEFAULT_LIMIT } = {}) {
    this.ttlMs = ttlMs;
    this.limit = limit;
    this.items = new Map();
    this.latest = new Map();
  }

  prune(now = Date.now()) {
    for (const [id, entry] of this.items) {
      if (entry.expiresAt <= now) this.items.delete(id);
    }
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value);
    for (const [key, id] of this.latest) if (!this.items.has(id)) this.latest.delete(key);
  }

  remember(observation) {
    this.prune();
    const observationId = crypto.randomUUID();
    const createdAt = Date.now();
    const value = {
      ...observation,
      observationId,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + this.ttlMs).toISOString(),
      consumed: false
    };
    this.items.set(observationId, { value, expiresAt: createdAt + this.ttlMs });
    this.latest.set(windowKey(value.window), observationId);
    this.prune();
    return value;
  }

  get({ observationId, processId, handle } = {}, { consume = false } = {}) {
    this.prune();
    let id = observationId;
    if (!id && (processId || handle)) {
      const candidates = [...this.items.values()].map((entry) => entry.value).filter((value) => {
        if (processId && Number(value.window?.processId) !== Number(processId)) return false;
        if (handle && String(value.window?.handle) !== String(handle)) return false;
        return true;
      });
      id = candidates.at(-1)?.observationId;
    }
    const entry = id ? this.items.get(id) : null;
    if (!entry) throw new Error("Observation is missing or expired; call computer_observe again");
    if (entry.value.consumed) throw new Error("Observation was already used; use the refreshed observation returned by the previous action");
    if (consume) entry.value.consumed = true;
    return entry.value;
  }

  clear() {
    this.items.clear();
    this.latest.clear();
  }
}
