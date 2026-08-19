import fs from "node:fs";
import path from "node:path";
import { launchDesktop } from "./desktop.js";

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function cdata(value) {
  return `<![CDATA[${String(value).replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function slug(value) {
  return String(value || "NewGame").normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "NewGame";
}

function placeXml(name) {
  const title = escapeXml(name);
  return `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">
  <External>null</External>
  <External>nil</External>
  <Item class="Workspace" referent="RBX_WORKSPACE">
    <Properties><string name="Name">Workspace</string></Properties>
    <Item class="Part" referent="RBX_BASEPLATE">
      <Properties>
        <bool name="Anchored">true</bool>
        <int name="BrickColor">194</int>
        <CoordinateFrame name="CFrame"><X>0</X><Y>-0.5</Y><Z>0</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame>
        <string name="Name">Baseplate</string>
        <Vector3 name="Size"><X>512</X><Y>1</Y><Z>512</Z></Vector3>
        <token name="TopSurface">0</token><token name="BottomSurface">0</token>
      </Properties>
    </Item>
    <!-- FORGE_WORKSPACE_ITEMS -->
  </Item>
  <Item class="Players" referent="RBX_PLAYERS"><Properties><string name="Name">Players</string></Properties></Item>
  <Item class="Lighting" referent="RBX_LIGHTING"><Properties><string name="Name">Lighting</string><float name="Brightness">2</float><double name="ClockTime">14</double></Properties></Item>
  <Item class="ReplicatedStorage" referent="RBX_REPLICATED_STORAGE">
    <Properties><string name="Name">ReplicatedStorage</string></Properties>
    <!-- FORGE_SHARED_SCRIPTS -->
  </Item>
  <Item class="ServerScriptService" referent="RBX_SERVER_SCRIPT_SERVICE">
    <Properties><string name="Name">ServerScriptService</string></Properties>
    <!-- FORGE_SERVER_SCRIPTS -->
  </Item>
  <Item class="StarterPlayer" referent="RBX_STARTER_PLAYER">
    <Properties><string name="Name">StarterPlayer</string></Properties>
    <Item class="StarterPlayerScripts" referent="RBX_STARTER_PLAYER_SCRIPTS">
      <Properties><string name="Name">StarterPlayerScripts</string></Properties>
      <!-- FORGE_CLIENT_SCRIPTS -->
    </Item>
  </Item>
  <Item class="SoundService" referent="RBX_SOUND_SERVICE"><Properties><string name="Name">SoundService</string></Properties></Item>
  <Meta name="ForgeProjectName">${title}</Meta>
</roblox>
`;
}

function resolveProjectPath(workspace, args) {
  if (args.path) return path.resolve(workspace, args.path);
  const projectName = slug(args.name);
  return path.join(workspace, "RobloxProjects", projectName, `${projectName}.rbxlx`);
}

function scriptMarker(scriptType) {
  if (scriptType === "LocalScript") return "<!-- FORGE_CLIENT_SCRIPTS -->";
  if (scriptType === "ModuleScript") return "<!-- FORGE_SHARED_SCRIPTS -->";
  return "<!-- FORGE_SERVER_SCRIPTS -->";
}

function scriptXml(name, source, scriptType) {
  return `    <Item class="${scriptType}" referent="RBX_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}">
      <Properties><string name="Name">${escapeXml(name)}</string><ProtectedString name="Source">${cdata(source)}</ProtectedString></Properties>
    </Item>`;
}

export async function executeRobloxProject(config, args = {}) {
  const action = args.action || "create_place";
  const file = resolveProjectPath(config.workspace, args);
  if (action === "build_place") {
    const created = await executeRobloxProject(config, { ...args, action: "create_place" });
    for (const script of args.scripts || []) {
      await executeRobloxProject(config, {
        action: "add_script",
        path: created.path,
        scriptName: script.name || "Main",
        scriptType: script.type || "Script",
        source: script.source || ""
      });
    }
    const inspected = await executeRobloxProject(config, { action: "inspect", path: created.path });
    return {
      ...inspected,
      action,
      created: true,
      opened: false,
      mode: "background",
      format: "rbxlx",
      taskComplete: true,
      summary: `Roblox place created and verified at ${inspected.path}. Scripts: ${inspected.scripts.map((script) => `${script.type} ${script.name}`).join(", ") || "none"}. Roblox Studio was not opened or focused.`
    };
  }
  if (action === "create_place") {
    if (fs.existsSync(file) && args.overwrite !== true) throw new Error(`Roblox place already exists: ${file}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, placeXml(args.name || path.basename(file, path.extname(file))), "utf8");
    return { ok: true, action, path: file, format: "rbxlx", created: true, opened: false, mode: "background" };
  }
  if (!fs.existsSync(file)) throw new Error(`Roblox place not found: ${file}`);
  if (action === "add_script") {
    const scriptType = ["Script", "LocalScript", "ModuleScript"].includes(args.scriptType) ? args.scriptType : "Script";
    const marker = scriptMarker(scriptType);
    const content = fs.readFileSync(file, "utf8");
    if (!content.includes(marker)) throw new Error("This place was not generated by ForgeAgent or its script markers are missing");
    const addition = `${scriptXml(args.scriptName || "Main", args.source || "", scriptType)}\n    ${marker}`;
    fs.writeFileSync(file, content.replace(marker, addition), "utf8");
    return { ok: true, action, path: file, scriptName: args.scriptName || "Main", scriptType, bytes: Buffer.byteLength(args.source || "") };
  }
  if (action === "inspect") {
    const content = fs.readFileSync(file, "utf8");
    return {
      ok: true,
      action,
      path: file,
      bytes: Buffer.byteLength(content),
      services: [...content.matchAll(/<Item class="([^"]+)"/g)].map((match) => match[1]),
      scripts: [...content.matchAll(/<Item class="(Script|LocalScript|ModuleScript)"[^>]*>[\s\S]*?<string name="Name">([^<]+)<\/string>/g)].map((match) => ({ type: match[1], name: match[2] }))
    };
  }
  if (action === "open_in_studio") {
    if (args.mode !== "foreground") return { ok: false, action, path: file, opened: false, rejected: "foreground_required", message: "Opening Roblox Studio is a foreground action. The place remains ready on disk." };
    const launched = await launchDesktop({ target: file, mode: "foreground", waitMs: args.waitMs || 3000 });
    return { ...launched, ok: launched.ok !== false, action, path: file, opened: true };
  }
  throw new Error(`Unknown Roblox project action: ${action}`);
}
