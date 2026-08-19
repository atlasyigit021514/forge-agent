import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, publicConfig, writeJson, DATA_DIR } from "./config.js";
import { createSession, startSession, sessionView, getSession, subscribeSession, cancelSession, resumeSession } from "./agent.js";
import { testProvider } from "./provider.js";
import { getMemories, forget } from "./memory.js";
import { listSkills, installSkill, downloadSkill } from "./skills.js";
import { startShell, writeShell, readShell, stopShell, listShells } from "./shells.js";
import { warmComputerWorker } from "./desktop.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
let config = loadConfig();

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) throw new Error("Request too large"); }
  return raw ? JSON.parse(raw) : {};
}

function saveConfig(input) {
  const priorKey = config.provider.apiKey;
  const priorCompressionKey = config.optimization.semanticToolCompression.apiKey;
  config = {
    ...config, ...input,
    provider: { ...config.provider, ...input.provider, apiKey: input.provider?.apiKey === "••••••••" ? priorKey : (input.provider?.apiKey ?? priorKey) },
    agent: { ...config.agent, ...input.agent },
    compaction: { ...config.compaction, ...input.compaction },
    context: { ...config.context, ...input.context },
    optimization: {
      ...config.optimization,
      ...input.optimization,
      graphify: { ...config.optimization.graphify, ...input.optimization?.graphify },
      contextVirtualMemory: { ...config.optimization.contextVirtualMemory, ...input.optimization?.contextVirtualMemory },
      tokenKernel: { ...config.optimization.tokenKernel, ...input.optimization?.tokenKernel },
      deduplicateToolResults: { ...config.optimization.deduplicateToolResults, ...input.optimization?.deduplicateToolResults },
      semanticToolCompression: {
        ...config.optimization.semanticToolCompression,
        ...input.optimization?.semanticToolCompression,
        apiKey: input.optimization?.semanticToolCompression?.apiKey === "••••••••"
          ? priorCompressionKey
          : (input.optimization?.semanticToolCompression?.apiKey ?? priorCompressionKey)
      }
    }
  };
  writeJson(path.join(DATA_DIR, "config.json"), config);
  return publicConfig(config);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/config") return json(res, 200, publicConfig(config));
    if (req.method === "PUT" && url.pathname === "/api/config") return json(res, 200, saveConfig(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/config/reload") { config = loadConfig(); return json(res, 200, publicConfig(config)); }
    if (req.method === "POST" && url.pathname === "/api/provider/test") return json(res, 200, await testProvider(config));
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const input = await body(req), session = createSession(config, input.message, input.history || []);
      return json(res, 202, startSession(config, session));
    }
    const sessionGet = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (req.method === "GET" && sessionGet) return json(res, 200, sessionView(getSession(sessionGet[1]), Number(url.searchParams.get("after") || 0)));
    const sessionEvents = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (req.method === "GET" && sessionEvents) {
      const session = getSession(sessionEvents[1]), after = Number(url.searchParams.get("after") || 0);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      const send = (item) => res.write(`id: ${item.index}\ndata: ${JSON.stringify(item)}\n\n`);
      session.events.slice(after).forEach(send);
      const unsubscribe = subscribeSession(session.id, send);
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
      const close = () => { clearInterval(heartbeat); unsubscribe(); };
      req.on("close", close); return;
    }
    const cancel = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancel) return json(res, 202, cancelSession(cancel[1]));
    const sessionInput = url.pathname.match(/^\/api\/sessions\/([^/]+)\/input$/);
    if (req.method === "POST" && sessionInput) { const input = await body(req); return json(res, 202, await resumeSession(config, sessionInput[1], input.input)); }
    if (req.method === "GET" && url.pathname === "/api/memories") return json(res, 200, getMemories());
    const memory = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
    if (req.method === "DELETE" && memory) return json(res, 200, forget(memory[1]));
    if (req.method === "GET" && url.pathname === "/api/skills") return json(res, 200, listSkills());
    if (req.method === "POST" && url.pathname === "/api/skills") return json(res, 200, await installSkill(await body(req)));
    if (req.method === "POST" && url.pathname === "/api/skills/download") return json(res, 200, await downloadSkill(await body(req)));
    if (req.method === "GET" && url.pathname === "/api/shells") return json(res, 200, listShells());
    if (req.method === "POST" && url.pathname === "/api/shells") return json(res, 200, startShell(path.resolve(config.workspace), (await body(req)).command || ""));
    const shellRead = url.pathname.match(/^\/api\/shells\/([^/]+)\/read$/);
    if (req.method === "GET" && shellRead) return json(res, 200, readShell(shellRead[1]));
    const shellWrite = url.pathname.match(/^\/api\/shells\/([^/]+)\/write$/);
    if (req.method === "POST" && shellWrite) { const input = await body(req); return json(res, 200, writeShell(shellWrite[1], input.input || "", input.appendNewline !== false)); }
    const shellStop = url.pathname.match(/^\/api\/shells\/([^/]+)\/stop$/);
    if (req.method === "POST" && shellStop) return json(res, 200, stopShell(shellStop[1]));
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(publicDir, requested);
    if ((file !== publicDir && !file.startsWith(`${publicDir}${path.sep}`)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: "Not found" });
    const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
    res.writeHead(200, { "content-type": `${types[path.extname(file)] || "application/octet-stream"}; charset=utf-8` });
    fs.createReadStream(file).pipe(res);
  } catch (error) { json(res, 500, { error: error.message }); }
});

const port = Number(process.env.PORT || 4317);
const host = process.env.HOST || "127.0.0.1";
server.listen(port, host, () => {
  console.log(`Forge Agent running at http://${host}:${port}`);
  warmComputerWorker().catch((error) => console.warn(`Computer worker warm-up failed: ${error.message}`));
});
