import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getMemories, remember, forget, searchMemories } from "./memory.js";
import { listSkills, readSkill, installSkill, downloadSkill } from "./skills.js";
import { startShell, writeShell, readShell, stopShell, listShells } from "./shells.js";

const baseToolDefinitions = [
  { type: "function", function: { name: "list_files", description: "List files under a directory", parameters: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer", minimum: 1, maximum: 5 } } } } },
  { type: "function", function: { name: "read_file", description: "Read a text file (supports line ranges)", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" } } } } },
  { type: "function", function: { name: "write_file", description: "Create or replace a text file", parameters: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } } },
  { type: "function", function: { name: "apply_patch", description: "Replace one exact block of text in a file", parameters: { type: "object", required: ["path", "oldText", "newText"], properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } } } } },
  { type: "function", function: { name: "search_files", description: "Search text in workspace files", parameters: { type: "object", required: ["query"], properties: { query: { type: "string" }, path: { type: "string" }, maxResults: { type: "integer" } } } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command in the workspace", parameters: { type: "object", required: ["command"], properties: { command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer" } } } } },
  { type: "function", function: { name: "shell_start", description: "Start a persistent shell session", parameters: { type: "object", properties: { cwd: { type: "string" }, command: { type: "string" } } } } },
  { type: "function", function: { name: "shell_write", description: "Send input to a running shell session", parameters: { type: "object", required: ["sessionId", "input"], properties: { sessionId: { type: "string" }, input: { type: "string" }, appendNewline: { type: "boolean" } } } } },
  { type: "function", function: { name: "shell_read", description: "Read output from a shell session", parameters: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, fromStart: { type: "boolean" } } } } },
  { type: "function", function: { name: "shell_stop", description: "Stop a shell session", parameters: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } } } },
  { type: "function", function: { name: "shell_list", description: "List shell sessions", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "file_info", description: "Get file or directory metadata", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "make_directory", description: "Create a directory", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "copy_path", description: "Copy a file or directory", parameters: { type: "object", required: ["source", "destination"], properties: { source: { type: "string" }, destination: { type: "string" } } } } },
  { type: "function", function: { name: "move_path", description: "Move or rename a file or directory", parameters: { type: "object", required: ["source", "destination"], properties: { source: { type: "string" }, destination: { type: "string" } } } } },
  { type: "function", function: { name: "delete_path", description: "Delete a file or directory recursively", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "list_processes", description: "List running processes", parameters: { type: "object", properties: { filter: { type: "string" } } } } },
  { type: "function", function: { name: "memory_search", description: "Search persistent agent memory", parameters: { type: "object", properties: { query: { type: "string" } } } } },
  { type: "function", function: { name: "memory_save", description: "Save a persistent memory", parameters: { type: "object", required: ["text"], properties: { text: { type: "string" }, tags: { type: "array", items: { type: "string" } } } } } },
  { type: "function", function: { name: "memory_forget", description: "Delete a memory", parameters: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } },
  { type: "function", function: { name: "list_skills", description: "List installed skills", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "read_skill", description: "Read a skill's instructions", parameters: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } },
  { type: "function", function: { name: "install_skill", description: "Install a skill from content", parameters: { type: "object", required: ["name", "content"], properties: { name: { type: "string" }, content: { type: "string" } } } } },
  { type: "function", function: { name: "download_skill", description: "Download a skill from an HTTPS URL", parameters: { type: "object", required: ["name", "url"], properties: { name: { type: "string" }, url: { type: "string" } } } } }
];

const graphifyDefinition = { type: "function", function: {
  name: "graphify",
  description: "Build or query Graphify's local code knowledge graph to inspect a codebase with fewer context tokens",
  parameters: { type: "object", required: ["action"], properties: {
    action: { type: "string", enum: ["query", "extract", "status"] },
    query: { type: "string", description: "Natural-language graph query (query action)" },
    path: { type: "string", description: "Workspace-relative project path; defaults to ." },
    force: { type: "boolean", description: "Force graph replacement during extraction" }
  } }
} };

const contextRecallDefinition = { type: "function", function: {
  name: "context_recall",
  description: "Recall one exact page from a large tool result's Context Virtual Memory map",
  parameters: { type: "object", required: ["pageId"], properties: {
    pageId: { type: "string", description: "Exact pageId shown in a context_virtual_memory map" },
    startChar: { type: "integer", minimum: 0, description: "Optional page-relative start offset" },
    endChar: { type: "integer", minimum: 1, description: "Optional page-relative end offset" }
  } }
} };

const loadToolGroupDefinition = { type: "function", function: {
  name: "load_tool_group",
  description: "Expose an additional tool group when Token Kernel hid a capability needed for the task",
  parameters: { type: "object", required: ["group"], properties: {
    group: { type: "string", enum: ["filesystem", "shell", "memory", "skills", "processes", "graph"] }
  } }
} };

const KERNEL_CORE = new Set(["list_files", "read_file", "write_file", "apply_patch", "search_files", "run_command"]);
const KERNEL_GROUPS = {
  filesystem: ["file_info", "make_directory", "copy_path", "move_path", "delete_path"],
  shell: ["shell_start", "shell_write", "shell_read", "shell_stop", "shell_list"],
  memory: ["memory_search", "memory_save", "memory_forget"],
  skills: ["list_skills", "read_skill", "install_skill", "download_skill"],
  processes: ["list_processes"],
  graph: ["graphify"]
};

export function activateToolGroup(session, group) {
  const names = KERNEL_GROUPS[group];
  if (!names) throw new Error(`Unknown tool group: ${group}`);
  const active = session.activeToolGroups ||= new Set();
  active.add(group);
  return { activated: group, tools: names };
}

export function getToolDefinitions(config, session) {
  let definitions = config.optimization?.graphify?.enabled === false ? [...baseToolDefinitions] : [...baseToolDefinitions, graphifyDefinition];
  if (config.optimization?.tokenKernel?.enabled) {
    const allowed = new Set(KERNEL_CORE);
    for (const group of session?.activeToolGroups || []) for (const name of KERNEL_GROUPS[group] || []) allowed.add(name);
    definitions = definitions.filter((item) => allowed.has(item.function.name));
    definitions.push(loadToolGroupDefinition);
  }
  // Adaptive schema injection: zero schema-token cost until there is actually
  // a virtual page the model can recall.
  if (config.optimization?.contextVirtualMemory?.enabled !== false && session?.contextPages?.size) {
    definitions.push(contextRecallDefinition);
  }
  return definitions;
}

function resolveSafe(config, input = ".") {
  return path.resolve(config.workspace, input);
}

async function runCommand(command, cwd, timeoutMs, maxChars) {
  return await new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const child = isWin
      ? spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { cwd, windowsHide: true })
      : spawn("/bin/bash", ["-c", command], { cwd });
    let stdout = "", stderr = "", killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, Math.min(timeoutMs || 120000, 600000));
    child.stdout.on("data", (d) => { stdout += d; if (stdout.length > maxChars) stdout = stdout.slice(-maxChars); });
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > maxChars) stderr = stderr.slice(-maxChars); });
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut: killed }); });
  });
}

function listTree(root, depth, current = 0) {
  if (current >= depth) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((e) => !["node_modules", ".git", ".agent-data"].includes(e.name)).flatMap((entry) => {
    const full = path.join(root, entry.name);
    const item = { path: full, type: entry.isDirectory() ? "directory" : "file" };
    return entry.isDirectory() ? [item, ...listTree(full, depth, current + 1)] : [item];
  });
}

export async function executeTool(config, name, args) {
  const max = config.context?.maxOutputChars ?? 30000;
  switch (name) {
    case "graphify": {
      const opts = config.optimization?.graphify || {};
      if (opts.enabled === false) throw new Error("Graphify integration is disabled");
      const command = String(opts.command || "graphify").replace(/"/g, "");
      const target = resolveSafe(config, args.path || ".");
      if (args.action === "status") {
        const graph = path.join(target, "graphify-out", "graph.json");
        return fs.existsSync(graph) ? { available: true, graph, bytes: fs.statSync(graph).size } : { available: false, graph };
      }
      const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
      const cli = args.action === "query"
        ? `${command} query ${quote(args.query || "")}`
        : `${command} extract ${quote(target)}${args.force ? " --force" : ""}`;
      return runCommand(cli, target, opts.timeoutMs || 120000, max);
    }
    case "list_files": {
      const entries = listTree(resolveSafe(config, args.path), args.depth || 2);
      const shown = entries.slice(0, 300);
      if (entries.length > shown.length) shown.push({ path: `…[TRUNCATED: ${entries.length - shown.length} more entries]`, type: "note" });
      return shown;
    }
    case "read_file": {
      const lines = fs.readFileSync(resolveSafe(config, args.path), "utf8").split(/\r?\n/);
      return lines.slice(Math.max(0, (args.startLine || 1) - 1), args.endLine || lines.length).join("\n").slice(0, max);
    }
    case "write_file": fs.mkdirSync(path.dirname(resolveSafe(config, args.path)), { recursive: true }); fs.writeFileSync(resolveSafe(config, args.path), args.content); return { written: args.path, bytes: Buffer.byteLength(args.content) };
    case "apply_patch": {
      const file = resolveSafe(config, args.path), content = fs.readFileSync(file, "utf8");
      if (!content.includes(args.oldText)) throw new Error("oldText did not match exactly");
      if (content.indexOf(args.oldText) !== content.lastIndexOf(args.oldText)) throw new Error("oldText is not unique");
      fs.writeFileSync(file, content.replace(args.oldText, args.newText)); return { patched: args.path };
    }
    case "search_files": {
      const root = resolveSafe(config, args.path), needle = args.query.toLowerCase(), hits = [];
      for (const item of listTree(root, 8)) if (item.type === "file" && hits.length < (args.maxResults || 100)) {
        try { fs.readFileSync(item.path, "utf8").split(/\r?\n/).forEach((line, i) => { if (line.toLowerCase().includes(needle) && hits.length < (args.maxResults || 100)) hits.push({ path: item.path, line: i + 1, text: line.slice(0, 200) }); }); } catch {}
      } return hits;
    }
    case "run_command": return runCommand(args.command, resolveSafe(config, args.cwd), args.timeoutMs, max);
    case "shell_start": return startShell(resolveSafe(config, args.cwd), args.command);
    case "shell_write": return writeShell(args.sessionId, args.input, args.appendNewline !== false);
    case "shell_read": return readShell(args.sessionId, args.fromStart);
    case "shell_stop": return stopShell(args.sessionId);
    case "shell_list": return listShells();
    case "file_info": { const stat = fs.statSync(resolveSafe(config, args.path)); return { path: args.path, type: stat.isDirectory() ? "directory" : "file", bytes: stat.size, createdAt: stat.birthtime, modifiedAt: stat.mtime }; }
    case "make_directory": fs.mkdirSync(resolveSafe(config, args.path), { recursive: true }); return { created: args.path };
    case "copy_path": fs.cpSync(resolveSafe(config, args.source), resolveSafe(config, args.destination), { recursive: true, errorOnExist: true }); return { copied: args.source, destination: args.destination };
    case "move_path": fs.renameSync(resolveSafe(config, args.source), resolveSafe(config, args.destination)); return { moved: args.source, destination: args.destination };
    case "delete_path": fs.rmSync(resolveSafe(config, args.path), { recursive: true, force: false }); return { deleted: args.path };
    case "list_processes": {
      const isWin = process.platform === "win32";
      return isWin
        ? runCommand(`Get-Process${args.filter ? ` | Where-Object ProcessName -Like '*${String(args.filter).replace(/'/g, "''")}*'` : ""} | Select-Object -First 100 Id,ProcessName,CPU,WorkingSet | ConvertTo-Json -Compress`, config.workspace, 15000, max)
        : runCommand(`ps -eo pid,comm,pcpu,rss --sort=-pcpu | head -100`, config.workspace, 15000, max);
    }
    case "memory_search": return searchMemories(args.query);
    case "memory_save": return remember(args.text, args.tags);
    case "memory_forget": return forget(args.id);
    case "list_skills": return listSkills();
    case "read_skill": return readSkill(args.name);
    case "install_skill": return installSkill(args);
    case "download_skill": return downloadSkill(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
