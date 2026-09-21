import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { parse } from "yaml";
import type { CapabilityManifest, CapabilityVerification, RiskLevel, RouterPolicy } from "./types.js";

const capabilityTypes = new Set(["skill", "mcp_tool", "cli", "dsh", "model", "subagent"]);
const riskLevels = new Set(["low", "medium", "high", "critical"]);

export const defaultPolicy: RouterPolicy = {
  min_confidence: 0.55,
  single_stage_max_candidates: 32,
  top_k: 8,
  allowed_risk_levels: ["low", "medium", "high"],
  required_permissions: [],
  confirmation_risk_levels: ["medium", "high", "critical"],
  allow_unavailable_fallback: false,
  require_verified_candidates: false,
};

export function validateManifest(input: unknown, source = "manifest"): CapabilityManifest {
  if (!input || typeof input !== "object") throw new Error(`${source}: expected an object`);
  const value = input as Record<string, unknown>;
  const required = ["id", "name", "type", "description"];
  for (const key of required) {
    if (typeof value[key] !== "string" || !String(value[key]).trim()) {
      throw new Error(`${source}: ${key} is required`);
    }
  }
  if (!capabilityTypes.has(String(value.type))) {
    throw new Error(`${source}: type must be skill, mcp_tool, cli, dsh, model, or subagent`);
  }
  const risk = value.risk as Record<string, unknown> | undefined;
  if (risk?.level !== undefined && !riskLevels.has(String(risk.level))) {
    throw new Error(`${source}: risk.level is invalid`);
  }
  const verification = value.verification as Record<string, unknown> | undefined;
  if (verification?.status !== undefined && !["verified", "discovered", "unverified", "unknown"].includes(String(verification.status))) {
    throw new Error(`${source}: verification.status is invalid`);
  }
  return {
    ...(value as unknown as CapabilityManifest),
    version: value.version ? String(value.version) : "0.1.0",
    verification: {
      status: (verification?.status as CapabilityVerification | undefined) ?? "unknown",
      ...(verification?.source === undefined ? {} : { source: String(verification.source) }),
      ...(verification?.checked_at === undefined ? {} : { checked_at: String(verification.checked_at) }),
    },
    risk: {
      level: (risk?.level as RiskLevel | undefined) ?? "low",
      categories: Array.isArray(risk?.categories) ? risk.categories.map(String) : [],
    },
    permissions: Array.isArray(value.permissions) ? value.permissions.map(String) : [],
    availability: {
      ...(value.availability as CapabilityManifest["availability"] | undefined),
      available: (value.availability as Record<string, unknown> | undefined)?.available !== false,
    },
  };
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fields an inline candidate may carry that this shape still decides for itself.
 * `verification` and `availability` are deliberately not honoured here: an agent
 * asserting that its own tool is verified or available would weaken the policy
 * checks that exist to doubt it.
 */
const inlineFixedFields = ["verification", "availability", "execution", "metadata", "version"] as const;

function ignoredInlineFields(value: Record<string, unknown>): string[] {
  return inlineFixedFields.filter(key => value[key] !== undefined);
}

/** Accept common Agent tool shapes so callers can route without writing a manifest first. */
export function normalizeCapability(input: unknown, source = "candidate", warn: (message: string) => void = () => {}): CapabilityManifest {
  if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    if (value.type === "function" && value.function && typeof value.function === "object") {
      const fn = value.function as Record<string, unknown>;
      const name = String(fn.name ?? "").trim();
      if (name) {
        return validateManifest({
          id: name,
          name,
          type: "mcp_tool",
          description: String(fn.description ?? `Agent tool ${name}`),
          input_schema: fn.parameters,
          permissions: [],
          risk: { level: "low", categories: ["agent_tool"] },
          availability: { available: true },
          execution: { mode: "mcp", target: name, dry_run: true },
          verification: { status: "unverified", source: "agent_input" },
          metadata: { source: "agent_tool", original_type: "function" },
        }, source);
      }
    }
    if (typeof value.name === "string" && !value.id) {
      const inferredType = value.type === "model" || value.type === "subagent" ? value.type : "mcp_tool";
      // Safety metadata the caller supplied is kept: dropping a declared risk or
      // confirmation requirement would silently make an unsafe tool look safe.
      // Everything this shape still fixes is reported through `warn`.
      const ignored = ignoredInlineFields(value);
      if (ignored.length > 0) {
        warn(`${source}: inline candidate "${value.name}": ignored ${ignored.join(", ")} (send a full manifest with an id to set these)`);
      }
      return validateManifest({
        id: value.name,
        name: value.name,
        type: inferredType,
        description: String(value.description ?? `Agent tool ${value.name}`),
        input_schema: value.input_schema ?? value.inputSchema,
        permissions: Array.isArray(value.permissions) ? value.permissions.map(String) : [],
        risk: isRecord(value.risk)
          ? { level: value.risk.level, categories: Array.isArray(value.risk.categories) ? value.risk.categories.map(String) : ["agent_tool"] }
          : { level: "low", categories: ["agent_tool"] },
        ...(isRecord(value.policy) ? { policy: { requires_confirmation: value.policy.requires_confirmation === true } } : {}),
        availability: { available: true },
        execution: { mode: inferredType === "model" || inferredType === "subagent" ? inferredType : "mcp", target: value.name, dry_run: true },
        verification: { status: "unverified", source: "agent_input" },
        metadata: { source: "agent_tool" },
      }, source);
    }
  }
  return validateManifest(input, source);
}

export async function loadManifestFile(filePath: string): Promise<CapabilityManifest> {
  const absolute = resolve(filePath);
  const raw = await readFile(absolute, "utf8");
  const value = parse(raw);
  return validateManifest(value, absolute);
}

export async function loadPolicyFile(filePath?: string): Promise<RouterPolicy> {
  if (!filePath) return { ...defaultPolicy };
  const absolute = resolve(filePath);
  let raw: string;
  try {
    raw = await readFile(absolute, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaultPolicy };
    throw error;
  }
  const parsed = parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error(`${absolute}: policy must be an object`);
  return { ...defaultPolicy, ...(parsed as RouterPolicy) };
}

export class CapabilityRegistry {
  constructor(public readonly directory = ".jevrouter/capabilities") {}

  async ensure(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async add(sourcePath: string): Promise<string> {
    await this.ensure();
    const manifest = await loadManifestFile(sourcePath);
    const extension = [".yaml", ".yml", ".json"].includes(extname(sourcePath).toLowerCase())
      ? extname(sourcePath).toLowerCase()
      : ".json";
    const destination = join(this.directory, `${manifest.id.replace(/[^a-zA-Z0-9._-]/g, "_")}${extension}`);
    await copyFile(resolve(sourcePath), destination, 1);
    return destination;
  }

  async list(): Promise<CapabilityManifest[]> {
    await this.ensure();
    const names = (await readdir(this.directory)).filter((name) => [".json", ".yaml", ".yml"].includes(extname(name).toLowerCase()));
    const manifests: CapabilityManifest[] = [];
    for (const name of names.sort()) {
      const path = join(this.directory, name);
      if ((await stat(path)).isFile()) manifests.push(await loadManifestFile(path));
    }
    return manifests.sort((a, b) => a.id.localeCompare(b.id));
  }
}

export function policyForManifest(manifest: CapabilityManifest, policy: RouterPolicy): RouterPolicy {
  return {
    ...defaultPolicy,
    ...policy,
    required_permissions: [...(policy.required_permissions ?? [])],
    allowed_risk_levels: [...(policy.allowed_risk_levels ?? defaultPolicy.allowed_risk_levels ?? [])],
    confirmation_risk_levels: [...(policy.confirmation_risk_levels ?? defaultPolicy.confirmation_risk_levels ?? [])],
    // Keep this helper as a named boundary for future per-manifest policies.
    ...(manifest.policy ? {} : {}),
  };
}
