import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const skillsDir = path.join(DATA_DIR, "skills");

function safeName(name) {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(name)) throw new Error("Invalid skill name");
  return name;
}

export function listSkills() {
  fs.mkdirSync(skillsDir, { recursive: true });
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => {
      const content = fs.readFileSync(path.join(skillsDir, entry.name, "SKILL.md"), "utf8");
      return { name: entry.name, description: content.match(/^#\s+(.+)$/m)?.[1] || entry.name };
    });
}

export function readSkill(name) {
  return fs.readFileSync(path.join(skillsDir, safeName(name), "SKILL.md"), "utf8");
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

export function skillsPrompt() {
  const skills = listSkills();
  if (!skills.length) return "No local skills are installed.";
  return `Installed skills (read one with the read_skill tool when relevant):\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`;
}
