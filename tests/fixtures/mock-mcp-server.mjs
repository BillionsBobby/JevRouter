#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } })}\n`);
    } else if (message.method === "tools/list") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "search", description: "Search records", inputSchema: { type: "object" } }] } })}\n`);
    }
  }
});
