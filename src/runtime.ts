import { CachedJevProvider, DemoProvider, HttpJevProvider, OpenRouterJevProvider } from "./provider.js";
import type { JevProvider } from "./types.js";

export function createProvider(kind?: string): JevProvider {
  const apiKey = kind === "openrouter"
    ? process.env.OPENROUTER_API_KEY ?? process.env.JEV_API_KEY
    : kind === "typesafe"
      ? process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY
      : process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (kind === "demo" || (!apiKey && kind !== "typesafe" && kind !== "openrouter")) {
    if (!apiKey) console.error("No Jev key found; using the labelled offline demo provider");
    return maybeCache(new DemoProvider());
  }
  if (!apiKey) throw new Error("Set TYPESAFE_API_KEY/JEV_API_KEY or use --provider demo");
  if (kind === "openrouter" || (process.env.OPENROUTER_API_KEY && !process.env.TYPESAFE_API_KEY && !process.env.JEV_API_KEY)) {
    return maybeCache(new OpenRouterJevProvider(apiKey));
  }
  const endpoint = process.env.JEV_API_URL;
  return maybeCache(new HttpJevProvider({ apiKey, endpoint, model: process.env.JEV_MODEL ?? "jev-latest" }));
}

function maybeCache(provider: JevProvider): JevProvider {
  return process.env.JEV_ROUTER_CACHE === "0" ? provider : new CachedJevProvider(provider);
}
