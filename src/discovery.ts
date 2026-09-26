import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import type { CapabilityManifest } from "./types.js";

const execFileAsync = promisify(execFile);

export async function discoverSkills(root: string): Promise<CapabilityManifest[]> {
  const files = await findFiles(resolve(root), (name) => name === "SKILL.md");
  const result: CapabilityManifest[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const { frontmatter, body } = splitFrontmatter(source);
    const folder = basename(resolve(file, ".."));
    const parsed = frontmatter && typeof frontmatter === "object" ? frontmatter as Record<string, unknown> : {};
    const id = String(parsed.id ?? parsed.name ?? folder).trim().replace(/\s+/g, "_");
    const description = String(parsed.description ?? firstParagraph(body) ?? `Skill from ${relative(root, file)}`).trim();
    result.push({
      id: `skill.${id}`,
      name: String(parsed.name ?? id),
      type: "skill",
      version: String(parsed.version ?? "discovered"),
      description,
      verification: { status: "discovered", source: "skill_discovery" },
      input_schema: isObject(parsed.input_schema) ? parsed.input_schema : undefined,
      permissions: Array.isArray(parsed.permissions) ? parsed.permissions.map(String) : [],
      risk: { level: "low", categories: ["local_skill"] },
      availability: { available: true, healthcheck: false },
      execution: { mode: "skill", target: file, dry_run: true },
      policy: { requires_confirmation: false },
      metadata: { source: "skill_discovery", path: relative(root, file) },
    });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/** Read the routing metadata of Codex custom agents without exporting their private instructions. */
export async function discoverCodexAgents(root: string, selectedNames?: string[]): Promise<CapabilityManifest[]> {
  const files = await findFiles(resolve(root), (name) => name.toLowerCase().endsWith(".toml"));
  const selected = selectedNames ? new Set(selectedNames.map((name) => name.trim()).filter(Boolean)) : null;
  const result: CapabilityManifest[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const name = tomlString(source, "name");
    const description = tomlString(source, "description");
    if (!name || !description || (selected && !selected.has(name))) continue;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    result.push({
      id: `codex_agent.${slug}`,
      name,
      type: "subagent",
      description,
      verification: { status: "discovered", source: "codex_agent_toml" },
      permissions: [],
      risk: { level: "low", categories: ["codex_subagent"] },
      availability: { available: true, healthcheck: false },
      execution: { mode: "subagent", target: name, dry_run: true },
      metadata: { source: "codex_agent_toml", path: relative(root, file) },
    });
  }
  if (selected) {
    const found = new Set(result.map((candidate) => candidate.name));
    const missing = [...selected].filter((name) => !found.has(name));
    if (missing.length > 0) throw new Error(`Codex agent profile not found: ${missing.join(", ")}`);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function discoverClis(commands: string[], timeoutMs = 3_000): Promise<CapabilityManifest[]> {
  const result: CapabilityManifest[] = [];
  for (const rawCommand of commands.map((value) => value.trim()).filter(Boolean)) {
    const command = rawCommand.split(/\s+/)[0];
    let help = "";
    let available = true;
    let reason: string | undefined;
    try {
      const output = await execFileAsync(command, ["--help"], { timeout: timeoutMs, maxBuffer: 64 * 1024 });
      help = `${output.stdout}\n${output.stderr}`.trim();
    } catch (error) {
      available = false;
      reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
    result.push({
      id: `cli.${command.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
      name: command,
      type: "cli",
      version: "discovered",
      description: firstParagraph(help) ?? `CLI command ${command}`,
      verification: { status: available ? "verified" : "unknown", source: "cli_discovery", checked_at: new Date().toISOString() },
      availability: { available, reason, command, healthcheck: true },
      risk: { level: "medium", categories: ["external_process"] },
      execution: { mode: "cli", target: rawCommand, dry_run: true },
      policy: { requires_confirmation: true },
      metadata: { source: "cli_discovery", help_excerpt: help.slice(0, 1_000) },
    });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export async function discoverDsh(rootOrFile: string): Promise<CapabilityManifest[]> {
  const path = resolve(rootOrFile);
  const files = (await stat(path)).isFile() ? [path] : await findFiles(path, (name) => name === "manifest.json" || name.startsWith("dsh") && extname(name) === ".json");
  const result: CapabilityManifest[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const plugin = isObject(parsed.plugin) ? parsed.plugin : parsed;
      const id = String(plugin.id ?? plugin.name ?? basename(file, ".json"));
      const description = String(plugin.description ?? `DSH plugin ${id}`);
      result.push({
        id: id.startsWith("dsh.") ? id : `dsh.${id}`,
        name: String(plugin.name ?? id),
        type: "dsh",
        version: String(plugin.version ?? "discovered"),
        description,
        verification: { status: "discovered", source: "dsh_discovery" },
        input_schema: isObject(plugin.input_schema) ? plugin.input_schema : undefined,
        permissions: Array.isArray(plugin.permissions) ? plugin.permissions.map(String) : [],
        risk: { level: "high", categories: ["plugin_workflow"] },
        availability: { available: true, healthcheck: false },
        execution: { mode: "dsh", target: file, dry_run: true },
        policy: { requires_confirmation: true },
        metadata: { source: "dsh_discovery", path: relative(rootOrFile, file) },
      });
    } catch {
      // A directory can contain unrelated JSON. Ignore it and keep discovery read-only.
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

async function findFiles(root: string, predicate: (name: string) => boolean): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await findFiles(path, predicate));
    else if (entry.isFile() && predicate(entry.name)) result.push(path);
  }
  return result;
}

function splitFrontmatter(source: string): { frontmatter: unknown; body: string } {
  if (!source.startsWith("---")) return { frontmatter: null, body: source };
  const end = source.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: null, body: source };
  return { frontmatter: parse(source.slice(3, end)), body: source.slice(end + 5) };
}

function firstParagraph(source: string): string | undefined {
  return source.split(/\n\s*\n/).map((part) => part.replace(/^#\s+/, "").trim()).find(Boolean);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function tomlString(source: string, key: string): string | null {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*(?:"((?:\\\\.|[^"\\\\])*)"|'([^']*)')\\s*(?:#.*)?$`, "m"));
  if (!match) return null;
  if (match[2] !== undefined) return match[2].trim();
  try {
    return JSON.parse(`"${match[1]}"`).trim();
  } catch {
    return null;
  }
}
