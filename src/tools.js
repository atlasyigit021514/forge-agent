import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getMemories, remember, forget, searchMemories } from "./memory.js";
import { listSkills, readSkill, installSkill, downloadSkill } from "./skills.js";
import { startShell, writeShell, readShell, stopShell, listShells, runShell, waitShell } from "./shells.js";
import { listWindows, observeDesktop, interactDesktop, findAndActDesktop, focusWindow, clickDesktop, typeDesktop, keyDesktop, scrollDesktop, screenshotDesktop, launchDesktop, ocrDesktop, navigateDesktop, invokeDesktop, setDesktopValue } from "./desktop.js";
import { executeRobloxProject } from "./roblox.js";

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
  { type: "function", function: { name: "shell_run", description: "Run a command in a persistent shell and wait until it exits, becomes idle, or asks for input. If needsInput=true, the agent automatically pauses and asks the user; their answer is delivered to this same shell. Long-running commands remain alive in the background.", parameters: { type: "object", required: ["command"], properties: { command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 100, maximum: 120000 }, idleMs: { type: "integer", minimum: 100, maximum: 10000 }, promptPatterns: { type: "array", items: { type: "string" } } } } } },
  { type: "function", function: { name: "shell_wait", description: "Wait for more output, exit, or an interactive prompt from an existing persistent shell. Automatically pauses the agent when user input is detected.", parameters: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, timeoutMs: { type: "integer", minimum: 100, maximum: 120000 }, idleMs: { type: "integer", minimum: 100, maximum: 10000 }, promptPatterns: { type: "array", items: { type: "string" } } } } } },
  { type: "function", function: { name: "file_info", description: "Get file or directory metadata", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "make_directory", description: "Create a directory", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "copy_path", description: "Copy a file or directory", parameters: { type: "object", required: ["source", "destination"], properties: { source: { type: "string" }, destination: { type: "string" } } } } },
  { type: "function", function: { name: "move_path", description: "Move or rename a file or directory", parameters: { type: "object", required: ["source", "destination"], properties: { source: { type: "string" }, destination: { type: "string" } } } } },
  { type: "function", function: { name: "delete_path", description: "Delete a file or directory recursively", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "list_processes", description: "List running processes", parameters: { type: "object", properties: { filter: { type: "string" } } } } },
  { type: "function", function: { name: "computer_launch", description: "Launch any Windows desktop application or file and return its process id", parameters: { type: "object", required: ["target"], properties: { target: { type: "string", description: "Executable, application path, document, or URI" }, arguments: { type: "array", items: { type: "string" } }, waitMs: { type: "integer", minimum: 0, maximum: 30000 } } } } },
  { type: "function", function: { name: "computer_navigate", description: "FAST PATH: open an app/URL, search the web/YouTube, or find and play a YouTube video in ONE call. Use youtube_play for find/play/watch requests. Do not list windows, take screenshots, run OCR, or load shell tools first. Honor foreground/background; default background.", parameters: { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["open_url", "web_search", "youtube_search", "youtube_play", "open_app"] }, target: { type: "string", description: "URL, URI, executable, or app path for open_url/open_app" }, query: { type: "string", description: "Search phrase for web_search/youtube_search/youtube_play" }, mode: { type: "string", enum: ["foreground", "background"], description: "Whether the operation should take focus; defaults to background" }, arguments: { type: "array", items: { type: "string" } }, waitMs: { type: "integer", minimum: 0, maximum: 30000 } } } } },
  { type: "function", function: { name: "computer_windows", description: "List visible Windows desktop application windows with process ids, titles, and handles", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "computer_observe", description: "Observe exactly one Windows window and return a point-in-time observationId plus indexed controls. Use this only when the desired control text is unknown; for a known label use computer_find_and_act. Background is default and never focuses the app.", parameters: { type: "object", properties: { query: { type: "string", description: "Substring of window title or process name; must identify exactly one window" }, processId: { type: "integer" }, handle: { type: "integer" }, mode: { type: "string", enum: ["foreground", "background"] }, preferAccessibility: { type: "boolean" }, maxElements: { type: "integer", minimum: 1, maximum: 1000 }, maxDepth: { type: "integer", minimum: 1, maximum: 12 }, timeBudgetMs: { type: "integer", minimum: 100, maximum: 4000 }, timeoutMs: { type: "integer", minimum: 1000, maximum: 15000 } } } } },
  { type: "function", function: { name: "computer_interact", description: "Perform one action using an observationId and element index, then immediately return the refreshed observation. Observations are single-use, so stale/repeated actions are rejected. Background mode never focuses or falls back to foreground.", parameters: { type: "object", required: ["observationId", "elementIndex", "action"], properties: { observationId: { type: "string" }, elementIndex: { type: "integer", minimum: 0 }, action: { type: "string", enum: ["click", "invoke", "type", "set_value"] }, value: { type: "string" }, text: { type: "string" }, clearFirst: { type: "boolean" }, pressEnter: { type: "boolean" }, button: { type: "string", enum: ["left", "right", "middle"] }, count: { type: "integer", minimum: 1, maximum: 3 }, mode: { type: "string", enum: ["foreground", "background"] }, verify: { type: "boolean" }, expectChange: { type: "boolean" }, verifyDelayMs: { type: "integer", minimum: 100, maximum: 3000 } } } } },
  { type: "function", function: { name: "computer_find_and_act", description: "FAST UI PATH: observe a uniquely selected window, find one control by visible text, perform one action, and return verified refreshed state in a single call. Prefer this over separate windows/observe/invoke calls. Background never brings the app forward; rejected input returns ok=false without retrying foreground.", parameters: { type: "object", required: ["controlText", "action"], properties: { query: { type: "string" }, processId: { type: "integer" }, handle: { type: "integer" }, controlText: { type: "string" }, action: { type: "string", enum: ["click", "invoke", "type", "set_value"] }, value: { type: "string" }, text: { type: "string" }, clearFirst: { type: "boolean" }, pressEnter: { type: "boolean" }, mode: { type: "string", enum: ["foreground", "background"] }, verify: { type: "boolean" }, expectChange: { type: "boolean" }, verifyDelayMs: { type: "integer", minimum: 100, maximum: 3000 } } } } },
  { type: "function", function: { name: "computer_invoke", description: "Compatibility wrapper for computer_interact. Pass the observationId returned by computer_observe; the observation is consumed after one action.", parameters: { type: "object", required: ["observationId", "elementIndex"], properties: { observationId: { type: "string" }, elementIndex: { type: "integer", minimum: 0 }, mode: { type: "string", enum: ["foreground", "background"] }, count: { type: "integer", minimum: 1, maximum: 3 }, verifyDelayMs: { type: "integer", minimum: 100, maximum: 3000 } } } } },
  { type: "function", function: { name: "computer_set_value", description: "Compatibility wrapper for computer_interact set_value. Requires a fresh observationId.", parameters: { type: "object", required: ["observationId", "elementIndex", "value"], properties: { observationId: { type: "string" }, elementIndex: { type: "integer", minimum: 0 }, value: { type: "string" }, mode: { type: "string", enum: ["foreground", "background"] } } } } },
  { type: "function", function: { name: "computer_focus", description: "Restore and focus a Windows application window", parameters: { type: "object", properties: { query: { type: "string" }, processId: { type: "integer" } } } } },
  { type: "function", function: { name: "computer_click", description: "Click screen coordinates. Foreground mode uses real mouse input; background mode posts directly to the selected window without stealing focus and requires query or processId.", parameters: { type: "object", required: ["x", "y"], properties: { x: { type: "integer" }, y: { type: "integer" }, button: { type: "string", enum: ["left", "right", "middle"] }, count: { type: "integer", minimum: 1, maximum: 3 }, mode: { type: "string", enum: ["foreground", "background"] }, query: { type: "string" }, processId: { type: "integer" } } } } },
  { type: "function", function: { name: "computer_type", description: "Enter text. Foreground mode pastes into the focused field; background mode posts text directly to the selected window without stealing focus and requires query or processId.", parameters: { type: "object", required: ["text"], properties: { text: { type: "string" }, clearFirst: { type: "boolean" }, pressEnter: { type: "boolean" }, mode: { type: "string", enum: ["foreground", "background"] }, query: { type: "string" }, processId: { type: "integer" } } } } },
  { type: "function", function: { name: "computer_key", description: "Send a key or shortcut. Foreground mode supports Windows Forms SendKeys; background mode supports ^letter, arrows, Enter, Escape, Tab, Space, and F5 without stealing focus.", parameters: { type: "object", required: ["keys"], properties: { keys: { type: "string" }, mode: { type: "string", enum: ["foreground", "background"] }, query: { type: "string" }, processId: { type: "integer" } } } } },
  { type: "function", function: { name: "computer_scroll", description: "Scroll; positive is up and negative is down. Background mode posts to the selected window without moving the user's pointer or stealing focus.", parameters: { type: "object", properties: { amount: { type: "integer", minimum: -100, maximum: 100 }, x: { type: "integer" }, y: { type: "integer" }, mode: { type: "string", enum: ["foreground", "background"] }, query: { type: "string" }, processId: { type: "integer" } } } } },
  { type: "function", function: { name: "computer_screenshot", description: "Save the complete Windows virtual desktop to an absolute PNG path as user-facing evidence. The model cannot visually inspect this file through the tool result: NEVER use or retry this for navigation; use computer_observe or computer_ocr instead.", parameters: { type: "object", required: ["path"], properties: { path: { type: "string", description: "Absolute PNG output path" }, query: { type: "string" }, processId: { type: "integer" } } } } },
  { type: "function", function: { name: "computer_ocr", description: "Read window text with clickable screen coordinates. Foreground mode activates then captures; background mode captures the selected window without exposing or focusing it. Use only when high-level navigation or UI Automation is insufficient.", parameters: { type: "object", properties: { query: { type: "string", description: "Window title or process substring" }, processId: { type: "integer" }, mode: { type: "string", enum: ["foreground", "background"] }, maxLines: { type: "integer", minimum: 1, maximum: 1000 } } } } },
  { type: "function", function: { name: "request_user_input", description: "Pause this exact autonomous task when external information is truly required (for example OTP, login code, password, CAPTCHA, or a decision). Tell the user what is needed; after they answer, the same task and persistent shell sessions continue.", parameters: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, shellSessionId: { type: "string", description: "Optional persistent shell session waiting for this input" }, secret: { type: "boolean", description: "Mask the user's response in the UI and event history" } } } } },
  { type: "function", function: { name: "roblox_project", description: "FAST ROBLOX PATH: create and edit Roblox .rbxlx places directly on disk without foreground UI automation. For a new game use build_place with all scripts; it creates and verifies everything in one call. Opening Studio requires action=open_in_studio and explicit foreground mode.", parameters: { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["build_place", "create_place", "add_script", "inspect", "open_in_studio"] }, path: { type: "string", description: "Workspace-relative or absolute .rbxlx path; creation chooses RobloxProjects/<name> when omitted" }, name: { type: "string" }, overwrite: { type: "boolean" }, scripts: { type: "array", description: "Scripts created atomically by build_place", items: { type: "object", required: ["name", "source"], properties: { name: { type: "string" }, type: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"] }, source: { type: "string" } } } }, scriptName: { type: "string" }, scriptType: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"] }, source: { type: "string" }, mode: { type: "string", enum: ["foreground", "background"] }, waitMs: { type: "integer", minimum: 0, maximum: 30000 } } } } },
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
    group: { type: "string", enum: ["filesystem", "shell", "computer", "memory", "skills", "processes", "graph"] }
  } }
} };

const KERNEL_CORE = new Set(["list_files", "read_file", "write_file", "apply_patch", "search_files", "run_command", "computer_navigate"]);
const KERNEL_GROUPS = {
  filesystem: ["file_info", "make_directory", "copy_path", "move_path", "delete_path"],
  shell: ["shell_run", "shell_wait", "shell_start", "shell_write", "shell_read", "shell_stop", "shell_list"],
  computer: ["computer_launch", "computer_navigate", "computer_windows", "computer_observe", "computer_interact", "computer_find_and_act", "computer_invoke", "computer_set_value", "computer_focus", "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_screenshot", "computer_ocr", "roblox_project", "request_user_input"],
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
    if (!session?.fastComputerTask) definitions.push(loadToolGroupDefinition);
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
    case "shell_run": return runShell(resolveSafe(config, args.cwd), args.command, args);
    case "shell_wait": return waitShell(args.sessionId, args);
    case "computer_launch": return launchDesktop(args);
    case "computer_navigate": return navigateDesktop(args);
    case "computer_windows": return listWindows();
    case "computer_observe": return observeDesktop(args);
    case "computer_interact": return interactDesktop(args);
    case "computer_find_and_act": return findAndActDesktop(args);
    case "computer_invoke": return invokeDesktop(args);
    case "computer_set_value": return setDesktopValue(args);
    case "computer_focus": return focusWindow(args);
    case "computer_click": return clickDesktop(args);
    case "computer_type": return typeDesktop(args);
    case "computer_key": return keyDesktop(args);
    case "computer_scroll": return scrollDesktop(args);
    case "computer_screenshot": return screenshotDesktop(args);
    case "computer_ocr": return ocrDesktop(args);
    case "roblox_project": return executeRobloxProject(config, args);
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
