import { spawn } from "node:child_process";

const sessions = new Map();
const MAX_BUFFER = 200000;
const DEFAULT_PROMPT_PATTERNS = [
  /(?:verification|security|login|one[- ]?time|otp|passcode|password|token|code|input|answer|doğrulama|güvenlik|şifre|parola|kod|yanıt)[^\r\n]{0,80}[:?]\s*$/imu,
  /(?:enter|type|paste|provide|gir|yaz|yapıştır)[^\r\n]{0,80}(?:code|password|token|input|kod|şifre|parola)[^\r\n]{0,40}[:?]?\s*$/imu
];

function view(session, output = "") {
  return { id: session.id, pid: session.child.pid, cwd: session.cwd, running: session.running, exitCode: session.exitCode, output };
}

export function startShell(cwd, command = "") {
  const id = crypto.randomUUID();
  const isWin = process.platform === "win32";
  const child = isWin
    ? spawn("powershell.exe", ["-NoLogo", "-NoProfile"], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    : spawn("/bin/bash", ["--norc", "-i"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const session = { id, child, cwd, command, commandSent: !command, promptSatisfied: false, buffer: "", cursor: 0, running: true, exitCode: null, touchedAt: Date.now(), startupTimer: null };
  const dispatchCommand = () => {
    if (!command || session.commandSent || !session.running) return;
    session.commandSent = true;
    if (session.startupTimer) clearTimeout(session.startupTimer);
    child.stdin.write(`${command}\n`);
  };
  const append = (chunk) => {
    session.buffer += chunk.toString();
    if (session.buffer.length > MAX_BUFFER) { const removed = session.buffer.length - MAX_BUFFER; session.buffer = session.buffer.slice(removed); session.cursor = Math.max(0, session.cursor - removed); }
    if (command && !session.commandSent && (isWin ? /PS [^\r\n]*>\s*$/m.test(session.buffer) : /[$#>]\s*$/m.test(session.buffer))) dispatchCommand();
  };
  child.stdout.on("data", append); child.stderr.on("data", append);
  child.on("close", (code) => { if (session.startupTimer) clearTimeout(session.startupTimer); session.running = false; session.exitCode = code; });
  child.on("error", (error) => { append(`\n[shell error] ${error.message}\n`); session.running = false; });
  sessions.set(id, session);
  if (command) session.startupTimer = setTimeout(dispatchCommand, 1500);
  return view(session);
}

export function writeShell(id, input, appendNewline = true) {
  const session = sessions.get(id);
  if (!session) throw new Error("Shell session not found");
  if (!session.running) throw new Error(`Shell already exited with code ${session.exitCode}`);
  session.child.stdin.write(`${input}${appendNewline ? "\n" : ""}`);
  session.promptSatisfied = true;
  session.touchedAt = Date.now();
  return view(session);
}

export function readShell(id, fromStart = false) {
  const session = sessions.get(id);
  if (!session) throw new Error("Shell session not found");
  const start = fromStart ? 0 : session.cursor;
  const output = session.buffer.slice(start);
  session.cursor = session.buffer.length;
  session.touchedAt = Date.now();
  return view(session, output);
}

export function stopShell(id) {
  const session = sessions.get(id);
  if (!session) throw new Error("Shell session not found");
  if (session.running) { session.child.stdin.end(); session.child.kill(); }
  return view(session);
}

export function listShells() {
  return [...sessions.values()].map((session) => view(session));
}

function promptFrom(output, extraPatterns = []) {
  const tail = String(output || "").slice(-2000);
  const patterns = [...DEFAULT_PROMPT_PATTERNS, ...extraPatterns.map((value) => new RegExp(value, "imu"))];
  for (const pattern of patterns) {
    const match = tail.match(pattern);
    if (match) return match[0].trim() || "The command is waiting for input";
  }
  return null;
}

function promptFromCommand(command) {
  const powershell = String(command || "").match(/Read-Host(?:\s+-Prompt)?\s+['"]([^'"]+)['"]/i);
  if (powershell) return `${powershell[1]}:`;
  const posix = String(command || "").match(/\bread\s+(?:-[^\s]+\s+)*-p\s+['"]([^'"]+)['"]/i);
  return posix ? posix[1].trim() : null;
}

export async function waitShell(id, { timeoutMs = 15000, idleMs = 500, promptPatterns = [], fromStart = false } = {}) {
  const session = sessions.get(id);
  if (!session) throw new Error("Shell session not found");
  const start = fromStart ? 0 : session.cursor;
  const startedAt = Date.now();
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 15000, 100), 120000);
  let lastLength = session.buffer.length;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    if (session.buffer.length !== lastLength) { lastLength = session.buffer.length; lastChange = Date.now(); }
    const output = session.buffer.slice(start);
    const emittedPrompt = session.running ? promptFrom(output, promptPatterns) : null;
    const commandPrompt = session.running && session.commandSent && !session.promptSatisfied && Date.now() - startedAt >= 250 ? promptFromCommand(session.command) : null;
    const prompt = emittedPrompt || commandPrompt;
    if (prompt || !session.running || (output && Date.now() - startedAt >= 500 && Date.now() - lastChange >= idleMs)) {
      session.cursor = session.buffer.length;
      session.touchedAt = Date.now();
      return {
        ...view(session, output),
        status: prompt ? "waiting_input" : (session.running ? "running" : "exited"),
        needsInput: Boolean(prompt),
        prompt
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const output = session.buffer.slice(start);
  session.cursor = session.buffer.length;
  session.touchedAt = Date.now();
  return { ...view(session, output), status: session.running ? "running" : "exited", needsInput: false, prompt: null, timedOut: session.running };
}

export async function runShell(cwd, command, options = {}) {
  if (!command) throw new Error("command is required");
  const session = startShell(cwd, command);
  return waitShell(session.id, { ...options, fromStart: true });
}
