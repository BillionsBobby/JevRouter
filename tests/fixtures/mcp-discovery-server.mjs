#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const mode = process.argv[2] ?? "single";
const logPath = process.argv[3];
let initialized = false;
let initializeComplete = false;
let buffer = "";

function log(message) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(message)}\n`);
}

function send(message, split = false) {
  const line = `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
  if (!split) {
    process.stdout.write(line);
    return;
  }
  const middle = Math.floor(line.length / 2);
  process.stdout.write(line.slice(0, middle));
  setTimeout(() => process.stdout.write(line.slice(middle)), 5);
}

function initialize(message) {
  if (mode === "hang") return;
  if (mode === "initialize-error") {
    send({ id: message.id, error: { code: -32602, message: "Initialization deliberately rejected" } });
    return;
  }
  if (mode === "exit-zero") {
    process.exit(0);
  }
  const capabilities = mode === "no-tools" ? {} : { tools: {} };
  const reply = () => {
    initializeComplete = true;
    send({
      id: message.id,
      result: {
        protocolVersion: mode === "unsupported-version" ? "2099-01-01" : "2024-11-05",
        capabilities,
        serverInfo: { name: "jevrouter-test", version: "1.0.0" },
      },
    }, mode === "chunked");
  };
  if (mode === "delayed-initialize") setTimeout(reply, 50);
  else reply();
}

function listTools(message) {
  if (!initializeComplete || !initialized) {
    send({ id: message.id, error: { code: -32000, message: "tools/list arrived before initialization completed" } });
    return;
  }
  if (mode === "later-page-error" && message.params?.cursor === "page-2") {
    send({ id: message.id, error: { code: -32001, message: "Second page deliberately failed" } });
    return;
  }
  if (mode === "malformed-cursor") {
    send({ id: message.id, result: { tools: [], nextCursor: 42 } });
    return;
  }
  if (mode === "cursor-cycle") {
    send({ id: message.id, result: { tools: [], nextCursor: "same-cursor" } });
    return;
  }
  if (mode === "paginated" || mode === "later-page-error") {
    if (message.params?.cursor === "page-2") {
      send({ id: message.id, result: { tools: [{ name: "second", description: "Second page", inputSchema: { type: "object", properties: { id: { type: "string" } } } }] } });
    } else {
      send({ id: message.id, result: { tools: [{ name: "first", description: "First page", inputSchema: { type: "object" } }], nextCursor: "page-2" } });
    }
    return;
  }
  if (mode === "empty-middle") {
    if (message.params?.cursor === "page-2") send({ id: message.id, result: { tools: [], nextCursor: "page-3" } });
    else if (message.params?.cursor === "page-3") send({ id: message.id, result: { tools: [{ name: "last", inputSchema: { type: "object" } }] } });
    else send({ id: message.id, result: { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "page-2" } });
    return;
  }
  if (mode === "chunked") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n`);
    send({ id: message.id, result: { tools: [{ name: "chunked", inputSchema: { type: "object" } }] } }, true);
    return;
  }
  send({ id: message.id, result: { tools: [{ name: "search", description: "Search records", inputSchema: { type: "object" } }] } });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    log(message);
    if (message.method === "initialize") initialize(message);
    else if (message.method === "notifications/initialized") initialized = true;
    else if (message.method === "tools/list") listTools(message);
    else if (message.method === "tools/call") send({ id: message.id, error: { code: -32601, message: "tools/call must not be used during discovery" } });
  }
});
