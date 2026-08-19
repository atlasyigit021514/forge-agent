import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeRobloxProject } from "../src/roblox.js";

test("builds and verifies a scripted Roblox place in one call without opening Studio", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "forge-roblox-"));
  const config = { workspace };
  try {
    const created = await executeRobloxProject(config, { action: "build_place", name: "Background Game", scripts: [{ name: "Main", type: "Script", source: "print(42)" }] });
    assert.equal(created.ok, true);
    assert.equal(created.taskComplete, true);
    assert.equal(created.opened, false);
    assert.ok(fs.existsSync(created.path));
    assert.deepEqual(created.scripts, [{ type: "Script", name: "Main" }]);
    assert.match(fs.readFileSync(created.path, "utf8"), /<roblox[\s\S]*print\(42\)[\s\S]*<\/roblox>/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test("background mode refuses to open Roblox Studio", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "forge-roblox-"));
  const config = { workspace };
  try {
    const created = await executeRobloxProject(config, { action: "create_place", name: "No Focus" });
    const opened = await executeRobloxProject(config, { action: "open_in_studio", path: created.path, mode: "background" });
    assert.equal(opened.ok, false);
    assert.equal(opened.rejected, "foreground_required");
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});
