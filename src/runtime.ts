import { CachedJevProvider, DemoProvider, HttpJevProvider, OpenRouterJevProvider } from "./provider.js";
import type { JevProvider } from "./types.js";

export type ProviderKind = "typesafe" | "openrouter" | "demo";
export type KeyName = "JEV_API_KEY" | "TYPESAFE_API_KEY" | "OPENROUTER_API_KEY";
export interface ProviderOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  cache?: boolean;
}

/** Resolve provider and key together, never borrowing another provider's credentials. */
export function providerConfiguration(kind?: string, env: NodeJS.ProcessEnv = process.env): { provider: ProviderKind; key: KeyName } {
  kind = kind?.trim() || undefined;
  if (kind !== undefined && !["typesafe", "openrouter", "demo"].includes(kind)) throw new Error("provider must be typesafe, openrouter, or demo");
  const provider = kind ?? (env.TYPESAFE_API_KEY?.trim() || env.JEV_API_KEY?.trim() ? "typesafe" : env.OPENROUTER_API_KEY?.trim() ? "openrouter" : "typesafe");
  const key: KeyName = provider === "openrouter" ? "OPENROUTER_API_KEY" : env.TYPESAFE_API_KEY?.trim() ? "TYPESAFE_API_KEY" : "JEV_API_KEY";
  return { provider: provider as ProviderKind, key };
}

export function createProvider(kind?: string, options: ProviderOptions = {}): JevProvider {
  const config = providerConfiguration(kind);
  if (config.provider === "demo") return new DemoProvider();
  const apiKey = options.apiKey?.trim() || process.env[config.key]?.trim();
  if (!apiKey) throw new Error(`Missing ${config.key}. Export it in the Agent's environment; offline tests must explicitly use --provider demo.`);
  const provider: JevProvider = config.provider === "openrouter"
    ? new OpenRouterJevProvider(apiKey, options.model ?? process.env.JEV_MODEL ?? "~typesafe/jev-latest")
    : new HttpJevProvider({ apiKey, endpoint: options.endpoint ?? process.env.JEV_API_URL, model: options.model ?? process.env.JEV_MODEL ?? "jev-latest" });
  // Live by default. Enabling a cache must be intentional for routing observations.
  return options.cache === true && process.env.JEV_ROUTER_CACHE !== "0" ? new CachedJevProvider(provider) : provider;
}
