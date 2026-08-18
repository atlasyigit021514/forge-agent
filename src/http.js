const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export async function fetchUrl({ url, timeoutMs = 15000, maxBytes = 200000, headers = {} }) {
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error(`Invalid URL: ${url}`); }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) throw new Error(`Unsupported protocol: ${parsed.protocol} (only http/https)`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 120000));
  let response;
  try {
    response = await fetch(url, { redirect: "follow", headers, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw new Error(`Request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const body = buffer.subarray(0, Math.max(0, maxBytes)).toString("utf8");
  return {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type") || "",
    bytes: buffer.length,
    truncated: buffer.length > maxBytes,
    body
  };
}
