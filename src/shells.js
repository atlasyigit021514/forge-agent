import { spawn } from "node:child_process";

const sessions = new Map();
const MAX_BUFFER = 200000;

function view(session, output = "") {
  return { id: session.id, pid: session.child.pid, cwd: session.cwd, running: session.running, exitCode: session.exitCode, output };
}

export function startShell(cwd, command = "") {
  const id = crypto.randomUUID();
  const isWin = process.platform === "win32";
  const child = isWin
    ? spawn("powershell.exe", ["-NoLogo", "-NoProfile"], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    : spawn("/bin/bash", ["--norc", "-i"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const session = { id, child, cwd, buffer: "", cursor: 0, running: true, exitCode: null, touchedAt: Date.now() };
  const append = (chunk) => { session.buffer += chunk.toString(); if (session.buffer.length > MAX_BUFFER) { const removed = session.buffer.length - MAX_BUFFER; session.buffer = session.buffer.slice(removed); session.cursor = Math.max(0, session.cursor - removed); } };
  child.stdout.on("data", append); child.stderr.on("data", append);
  child.on("close", (code) => { session.running = false; session.exitCode = code; });
  child.on("error", (error) => { append(`\n[shell error] ${error.message}\n`); session.running = false; });
  sessions.set(id, session);
  if (command) child.stdin.write(`${command}\n`);
  return view(session);
}

export function writeShell(id, input, appendNewline = true) {
  const session = sessions.get(id);
  if (!session) throw new Error("Shell session not found");
  if (!session.running) throw new Error(`Shell already exited with code ${session.exitCode}`);
  session.child.stdin.write(`${input}${appendNewline ? "\n" : ""}`);
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
