import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { providerConfiguration } from "./runtime.js";
import type { AgentProvider } from "./agent-setup.js";

/** Resolve a live provider without ever putting a secret in argv or on disk. */
export async function ensureAgentCredentials(requested?: AgentProvider): Promise<AgentProvider> {
  const existing = providerConfiguration(requested);
  if (process.env[existing.key]?.trim()) return existing.provider as AgentProvider;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(`Missing ${existing.key}. Export TYPESAFE_API_KEY/JEV_API_KEY or OPENROUTER_API_KEY, or run agent start in an interactive terminal to enter a key securely.`);
  }

  const provider = requested ?? await askProvider();
  const keyName = provider === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY";
  const key = await readSecret(`Paste your ${provider === "openrouter" ? "OpenRouter" : "official Jev"} API key: `);
  if (!key) throw new Error(`No ${keyName} was entered`);
  process.env[keyName] = key;
  return provider;
}

async function askProvider(): Promise<AgentProvider> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question("Jev provider [typesafe/openrouter] (typesafe): ")).trim().toLowerCase();
    if (!answer || answer === "typesafe" || answer === "jev" || answer === "official") return "typesafe";
    if (answer === "openrouter") return "openrouter";
    throw new Error("Provider must be typesafe or openrouter");
  } finally {
    prompt.close();
  }
}

function readSecret(message: string): Promise<string> {
  if (!stdin.setRawMode) return Promise.reject(new Error("Secure key entry requires a TTY"));
  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") return finish(new Error("Key entry cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };
    stdout.write(message);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
