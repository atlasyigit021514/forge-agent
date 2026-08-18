function endpoint(baseUrl) {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

const transientStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function retryDelay(response, attempt, baseMs) {
  const retryAfter = response?.headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30000);
    const dateMs = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateMs) && dateMs > 0) return Math.min(dateMs, 30000);
  }
  const exponential = baseMs * (2 ** attempt);
  const jitter = Math.floor(Math.random() * Math.max(1, baseMs * 0.25));
  return Math.min(exponential + jitter, 30000);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mergeDelta(message, delta = {}) {
  if (delta.role) message.role = delta.role;
  if (typeof delta.content === "string") message.content = (message.content || "") + delta.content;
  for (const part of delta.tool_calls || []) {
    const index = part.index ?? 0;
    const call = message.tool_calls[index] ||= { id: "", type: "function", function: { name: "", arguments: "" } };
    if (part.id) call.id += part.id;
    if (part.type) call.type = part.type;
    if (part.function?.name) call.function.name += part.function.name;
    if (part.function?.arguments) call.function.arguments += part.function.arguments;
  }
}

async function readStreamingResponse(response, onDelta) {
  const message = { role: "assistant", content: "", tool_calls: [] };
  let usage = null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const body = await response.json();
    const complete = body.choices?.[0]?.message;
    if (!complete) throw new Error("Provider returned no assistant message");
    if (complete.content) onDelta(complete.content);
    return { message: complete, usage: body.usage || null };
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider returned an unreadable stream");
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data);
    usage = chunk.usage || usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    mergeDelta(message, delta);
    if (typeof delta.content === "string" && delta.content) onDelta(delta.content);
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) consume(block);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!message.content && !message.tool_calls.length) throw new Error("Provider returned no assistant message");
  if (!message.tool_calls.length) delete message.tool_calls;
  if (!message.content) message.content = null;
  return { message, usage };
}

export async function chatCompletion(config, messages, tools, onRetry = () => {}, onDelta = () => {}) {
  const { baseUrl, apiKey, model, headers = {}, maxRetries = 3, retryBaseMs = 750 } = config.provider;
  if (!baseUrl || !apiKey || !model) throw new Error("Configure the provider endpoint, API key, and model in Settings.");
  const attempts = Math.max(0, Math.min(Number(maxRetries) || 0, 10));
  let lastError;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    let response;
    const started = performance.now();
    try {
      const thinkingMode = config.agent.thinkingMode;
      const payload = { model, messages, tools, tool_choice: "auto", temperature: config.agent.temperature, stream: true };
      if (config.provider.includeUsage) payload.stream_options = { include_usage: true };
      if (thinkingMode === "low" || thinkingMode === "medium" || thinkingMode === "high") payload.reasoning_effort = thinkingMode;
      response = await fetch(endpoint(baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180000)
      });
      if (!response.ok) {
        const text = await response.text();
        const error = new Error(`Provider error ${response.status}: ${text.slice(0, 2000)}`);
        if (!transientStatuses.has(response.status) || attempt === attempts) throw error;
        lastError = error;
      } else {
        const result = await readStreamingResponse(response, onDelta);
        return { ...result, attempts: attempt + 1, latencyMs: Math.round(performance.now() - started) };
      }
    } catch (error) {
      if (response || attempt === attempts) throw error;
      lastError = error;
    }
    const delay = retryDelay(response, attempt, Math.max(50, Number(retryBaseMs) || 750));
    onRetry({ attempt: attempt + 1, delay, error: lastError?.message });
    await wait(delay);
  }
  throw lastError;
}

export async function testProvider(config) {
  const result = await chatCompletion({ ...config, agent: { ...config.agent, temperature: 0 } }, [{ role: "user", content: "Reply with exactly: connected" }], []);
  return { ok: true, response: result.message.content, usage: result.usage };
}
