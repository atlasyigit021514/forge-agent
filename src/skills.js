import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.js";

const skillsDir = path.join(DATA_DIR, "skills");
const builtInSkillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills");

function safeName(name) {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(name)) throw new Error("Invalid skill name");
  return name;
}

export function listSkills() {
  fs.mkdirSync(skillsDir, { recursive: true });
  const names = new Set();
  for (const root of [builtInSkillsDir, skillsDir]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md"))) names.add(entry.name);
    }
  }
  return [...names].sort().map((name) => {
    const content = readSkill(name);
    return { name, description: content.match(/^#\s+(.+)$/m)?.[1] || name };
  });
}

export function readSkill(name) {
  const validated = safeName(name);
  const localPath = path.join(skillsDir, validated, "SKILL.md");
  const builtInPath = path.join(builtInSkillsDir, validated, "SKILL.md");
  const selected = fs.existsSync(localPath) ? localPath : builtInPath;
  if (!fs.existsSync(selected)) throw new Error(`Skill not found: ${validated}`);
  return fs.readFileSync(selected, "utf8");
}

export function installSkill({ name, content }) {
  const dir = path.join(skillsDir, safeName(name));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
  return { name, installed: true };
}

export async function downloadSkill({ name, url }) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Skill URL must use HTTPS");
  const response = await fetch(parsed, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const content = await response.text();
  if (content.length > 250000) throw new Error("Skill is too large");
  return installSkill({ name, content });
}

export function skillsPrompt(query = "") {
  const skills = listSkills();
  if (!skills.length) return "No local skills are installed.";
  const catalog = `Installed skills (read one with the read_skill tool when relevant):\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`;
  const computerRequest = /youtube|browser|chrome|discord|roblox|studio|\bopen\b|\baç|click|tıkla|screen|ekran|uygulama|\bapp\b|video|web|site|foreground|background|arka plan|ön plan/i.test(String(query));
  if (!computerRequest || !skills.some((skill) => skill.name === "fast-computer-use")) return catalog;
  return `${catalog}\n\nAutomatically loaded relevant skill:\n${readSkill("fast-computer-use")}`;
}
