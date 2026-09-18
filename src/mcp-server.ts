import { createInterface } from "node:readline";
import { CapabilityRegistry, normalizeCapability } from "./manifest.js";
import { JevRouter } from "./router.js";
import { saveDecision } from "./store.js";
import type { CapabilityManifest, JevProvider, RouteInput, RouterPolicy } from "./types.js";

export interface McpServerOptions {
  registry: CapabilityRegistry;
  policy: RouterPolicy;
  provider: JevProvider;
}

const routeInputSchema = {
  type: "object",
  properties: {
    request: { type: "string", description: "The user's intent or task" },
    context: { type: "object", description: "Optional structured state for the decision" },
    input: { description: "Optional arguments to validate against the selected capability" },
    actor: { type: "string" },
    actor_permissions: { type: "array", items: { type: "string" } },
    candidates: { type: "array", items: { type: "object" } },
  },
  required: ["request"],
  additionalProperties: false,
} as const;

const agentInstructions = "Before choosing a model, tool, or subagent for a meaningful task, call jev_route with the user request and the available candidates. Pass native function-tool descriptors when available. Respect selected, needs_confirmation, and no_decision; never execute a filtered or unresolved capability, and do not treat probabilities as permission. JevRouter returns a decision handoff; the Agent remains responsible for the actual execution.";

export async function startMcpServer(options: McpServerOptions): Promise<void> {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      writeJsonRpc({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const response = await handleMessage(message, options);
    if (response) writeJsonRpc(response);
  }
}

export async function handleMessage(message: JsonRpcMessage, options: McpServerOptions): Promise<JsonRpcResponse | null> {
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return null;
  try {
    if (message.method === "initialize") {
      return result(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "jevrouter", version: "0.1.0" },
        instructions: agentInstructions,
      });
    }
    if (message.method === "ping") return result(message.id, {});
    if (message.method === "tools/list") return result(message.id, { tools: toolDefinitions() });
    if (message.method === "tools/call") return await callTool(message, options);
    return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: `Method not found: ${message.method}` } };
  } catch (error) {
    return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
  }
}

async function callTool(message: JsonRpcMessage, options: McpServerOptions): Promise<JsonRpcResponse> {
  const params = asObject(message.params);
  const name = typeof params.name === "string" ? params.name : "";
  const args = asObject(params.arguments);
  if (name === "jev_capabilities") {
    return toolResult(message.id, await options.registry.list());
  }
  if (name !== "jev_route") return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32602, message: `Unknown tool: ${name}` } };
  if (typeof args.request !== "string" || !args.request.trim()) {
    return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32602, message: "jev_route requires a non-empty request" } };
  }
  const routeInput: RouteInput = {
    request: args.request,
    context: isRecord(args.context) ? args.context : undefined,
    actor: typeof args.actor === "string" ? args.actor : undefined,
    actor_permissions: Array.isArray(args.actor_permissions) ? args.actor_permissions.map(String) : undefined,
    input: args.input,
  };
  const candidates = args.candidates === undefined
    ? await options.registry.list()
    : Array.isArray(args.candidates)
      ? args.candidates.map((candidate, index) => normalizeCapability(candidate, `arguments.candidates[${index}]`))
      : (() => { throw new Error("arguments.candidates must be an array"); })();
  const decision = await new JevRouter(options.provider, options.policy).route(routeInput, candidates);
  await saveDecision(decision);
  return toolResult(message.id, decision);
}

function toolDefinitions() {
  return [
    {
      name: "jev_route",
      description: "Call this before choosing a meaningful model, tool, or subagent. Pass the current candidate descriptors; JevRouter returns selected, confidence, probabilities, and policy status without executing anything.",
      inputSchema: routeInputSchema,
    },
    {
      name: "jev_capabilities",
      description: "List locally registered model, tool, skill, and subagent capabilities.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}

function toolResult(id: string | number | null | undefined, value: unknown): JsonRpcResponse {
  return result(id, {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false,
  });
}

function result(id: string | number | null | undefined, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function writeJsonRpc(message: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}
