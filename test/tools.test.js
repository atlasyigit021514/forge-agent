import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../src/tools.js";
import { startShell, writeShell, readShell, stopShell } from "../src/shells.js";

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
