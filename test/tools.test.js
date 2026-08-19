import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTool, getToolDefinitions } from "../src/tools.js";
import { startShell, writeShell, readShell, stopShell, runShell, waitShell } from "../src/shells.js";
import { createSession, resumeSession } from "../src/agent.js";

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "forge-test-"));
  return { workspace, context: { maxOutputChars: 30000 } };
}

test("writes and reads files inside the workspace", async () => {
  const config = fixture();
  await executeTool(config, "write_file", { path: "src/demo.txt", content: "hello forge" });
  assert.equal(await executeTool(config, "read_file", { path: "src/demo.txt" }), "hello forge");
});

test("reads files outside the workspace without restriction", async () => {
  const config = fixture();
  const outside = path.join(os.tmpdir(), `forge-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, "outside data");
  try {
    const content = await executeTool(config, "read_file", { path: outside });
    assert.equal(content, "outside data");
  } finally {
    fs.unlinkSync(outside);
  }
});

test("persistent shell accepts follow-up input and returns incremental output", async () => {
  const config = fixture();
  const shell = startShell(config.workspace);
  const isWin = process.platform === "win32";
  try {
    writeShell(shell.id, isWin ? "$value = 41" : "VALUE=41");
    writeShell(shell.id, isWin ? "Write-Output ($value + 1)" : "echo $((VALUE + 1))");
    let output = "";
    for (let i = 0; i < 20 && !output.includes("42"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      output += readShell(shell.id).output;
    }
    assert.match(output, /42/);
    assert.equal(readShell(shell.id).output, "");
  } finally { stopShell(shell.id); }
});

test("computer control and resumable user-input tools are exposed", () => {
  const names = getToolDefinitions({ optimization: { graphify: { enabled: false } } }, {}).map((tool) => tool.function.name);
  for (const name of ["computer_launch", "computer_navigate", "computer_windows", "computer_observe", "computer_interact", "computer_find_and_act", "computer_invoke", "computer_set_value", "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_screenshot", "computer_ocr", "roblox_project", "shell_run", "shell_wait", "request_user_input"]) {
    assert.ok(names.includes(name), `${name} should be available`);
  }
});

test("simple desktop tasks preload computer tools without reducing the configured turn budget", () => {
  const config = {
    ...fixture(),
    agent: { systemPrompt: "test", maxTurns: 1000, temperature: 0 },
    context: { maxOutputChars: 30000, memoryTopK: 0 },
    optimization: { graphify: { enabled: false }, tokenKernel: { enabled: true } },
    compaction: { enabled: false }
  };
  const session = createSession(config, "open youtube and find a funny video");
  assert.equal(session.turnLimit, 1000);
  assert.equal(session.computerMode, "background");
  assert.equal(session.thinkingMode, "none");
  assert.equal(session.fastComputerTask, true);
  assert.ok(session.activeToolGroups.has("computer"));
  assert.equal(session.activeToolGroups.has("shell"), false);
  const names = getToolDefinitions(config, session).map((tool) => tool.function.name);
  assert.ok(names.includes("computer_navigate"));
  assert.ok(names.includes("computer_windows"));
  assert.equal(names.includes("load_tool_group"), false);
  assert.match(session.messages[0].content, /Fast Computer Use/);
  const navigate = getToolDefinitions(config, session).find((tool) => tool.function.name === "computer_navigate");
  assert.ok(navigate.function.parameters.properties.action.enum.includes("youtube_play"));
});

test("explicit foreground wording selects foreground while ordinary computer work stays background", () => {
  const config = {
    ...fixture(),
    agent: { systemPrompt: "test", maxTurns: 1000, temperature: 0, thinkingMode: "high" },
    context: { maxOutputChars: 30000, memoryTopK: 0 },
    optimization: { graphify: { enabled: false }, tokenKernel: { enabled: true } },
    compaction: { enabled: false }
  };
  assert.equal(createSession(config, "Roblox Studio'da arka planda bir oyun oluştur").computerMode, "background");
  assert.equal(createSession(config, "Roblox Studio'yu önüme getir ve işlemi göster").computerMode, "foreground");
  assert.equal(createSession(config, "Use shell_run to execute this exact command: npm --version").thinkingMode, "none");
});

test("shell_run detects an input prompt and continues in the same process", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "forge-shell-prompt-"));
  const isWin = process.platform === "win32";
  const command = isWin ? "$answer = Read-Host 'Code'; Write-Output \"accepted:$answer\"" : "read -p 'Code: ' answer; echo accepted:$answer";
  const state = await runShell(workspace, command, { timeoutMs: 5000, idleMs: 150 });
  try {
    assert.equal(state.needsInput, true);
    writeShell(state.id, "7319");
    const completed = await waitShell(state.id, { timeoutMs: 5000, idleMs: 150 });
    assert.match(completed.output, /accepted:7319/);
  } finally {
    stopShell(state.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a simple shell handoff completes from verified resumed output without another model turn", async () => {
  const config = {
    ...fixture(),
    agent: { systemPrompt: "test", maxTurns: 1000, temperature: 0, thinkingMode: "high" },
    context: { maxOutputChars: 30000, memoryTopK: 0 },
    optimization: { graphify: { enabled: false }, tokenKernel: { enabled: true } },
    compaction: { enabled: false }
  };
  const command = process.platform === "win32" ? "$answer = Read-Host 'Code'; Write-Output \"accepted:$answer\"" : "read -p 'Code: ' answer; echo accepted:$answer";
  const shell = await runShell(config.workspace, command, { timeoutMs: 5000, idleMs: 150 });
  const session = createSession(config, `Use shell_run to execute this exact command: ${command}`);
  session.pending = { callId: null, name: "shell_input", args: { prompt: "Code:", shellSessionId: shell.id, secret: false } };
  try {
    const view = await resumeSession(config, session.id, "7319");
    assert.equal(view.done, true);
    assert.equal(view.status, "completed");
    assert.match(session.events.find((event) => event.type === "assistant" && event.data.automatic)?.data.content || "", /accepted:7319/);
  } finally { stopShell(shell.id); }
});

test("a waiting task delivers user input to its original shell and resumes", async () => {
  const config = {
    ...fixture(),
    agent: { systemPrompt: "test", maxTurns: 1, temperature: 0 },
    context: { maxOutputChars: 30000, memoryTopK: 0 },
    optimization: { graphify: { enabled: false } },
    compaction: { enabled: false }
  };
  const isWin = process.platform === "win32";
  const command = isWin ? "$answer = Read-Host 'Code'; Write-Output \"accepted:$answer\"" : "read -r answer; echo accepted:$answer";
  const shell = await runShell(config.workspace, command, { timeoutMs: 5000, idleMs: 150 });
  const session = createSession(config, "wait for a code");
  session.pending = { callId: "input-call", name: "request_user_input", args: { prompt: "Enter code", shellSessionId: shell.id }, createdAt: new Date().toISOString() };
  session.cancelled = true; // Resume mechanics are under test; avoid a provider call afterwards.
  try {
    const view = await resumeSession(config, session.id, "7319");
    assert.equal(view.pending, null);
    assert.match(session.messages.at(-1).content, /7319/);
    let output = "";
    for (let i = 0; i < 30 && !output.includes("accepted:7319"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      output += readShell(shell.id).output;
    }
    assert.match(output, /accepted:7319/);
  } finally { stopShell(shell.id); }
});
