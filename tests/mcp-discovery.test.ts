import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverMcpConfig } from "../src/mcp.js";

interface LoggedMessage {
  id?: number;
  method?: string;
  params?: { cursor?: string };
}

async function withServer<T>(mode: string, run: (configPath: string, logPath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "jevrouter-mcp-test-"));
  const configPath = join(directory, "mcp.json");
  const logPath = join(directory, "requests.jsonl");
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [resolve("tests/fixtures/mcp-discovery-server.mjs"), mode, logPath],
      },
    },
  }));
  try {
    return await run(configPath, logPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function messages(logPath: string): Promise<LoggedMessage[]> {
  const source = await readFile(logPath, "utf8");
  return source.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as LoggedMessage);
}

test("MCP discovery waits for initialization before listing tools", async () => {
  await withServer("delayed-initialize", async (configPath, logPath) => {
    const tools = await discoverMcpConfig(configPath, 1_000);
    assert.deepEqual(tools.map((tool) => tool.id), ["mcp.fixture.search"]);
    assert.deepEqual((await messages(logPath)).map((message) => message.method), [
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });
});

test("MCP discovery follows opaque cursors and preserves every tool", async () => {
  await withServer("paginated", async (configPath, logPath) => {
    const tools = await discoverMcpConfig(configPath);
    assert.deepEqual(tools.map((tool) => tool.id), ["mcp.fixture.first", "mcp.fixture.second"]);
    assert.deepEqual(tools[1]?.input_schema, { type: "object", properties: { id: { type: "string" } } });
    assert.deepEqual(tools[1]?.metadata, { source: "mcp_discovery", server: "fixture" });
    const requests = (await messages(logPath)).filter((message) => message.method === "tools/list");
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0]?.id, requests[1]?.id);
    assert.equal(requests[0]?.params?.cursor, undefined);
    assert.equal(requests[1]?.params?.cursor, "page-2");
  });
});

test("MCP discovery continues through an empty intermediate page", async () => {
  await withServer("empty-middle", async (configPath) => {
    const tools = await discoverMcpConfig(configPath);
    assert.deepEqual(tools.map((tool) => tool.id), ["mcp.fixture.first", "mcp.fixture.last"]);
  });
});

test("MCP discovery surfaces initialization errors without listing tools", async () => {
  await withServer("initialize-error", async (configPath, logPath) => {
    await assert.rejects(discoverMcpConfig(configPath, 1_000), /Initialization deliberately rejected/);
    assert.deepEqual((await messages(logPath)).map((message) => message.method), ["initialize"]);
  });
});

test("MCP discovery rejects a later page instead of returning partial results", async () => {
  await withServer("later-page-error", async (configPath) => {
    await assert.rejects(discoverMcpConfig(configPath), /Second page deliberately failed/);
  });
});

test("MCP discovery rejects malformed and cyclic cursors", async () => {
  await withServer("malformed-cursor", async (configPath) => {
    await assert.rejects(discoverMcpConfig(configPath), /nextCursor/);
  });
  await withServer("cursor-cycle", async (configPath) => {
    await assert.rejects(discoverMcpConfig(configPath), /cursor cycle/);
  });
});

test("MCP discovery accepts chunked responses and ignores notifications", async () => {
  await withServer("chunked", async (configPath) => {
    const tools = await discoverMcpConfig(configPath);
    assert.deepEqual(tools.map((tool) => tool.id), ["mcp.fixture.chunked"]);
  });
});

test("MCP discovery returns an empty list when the server does not advertise tools", async () => {
  await withServer("no-tools", async (configPath, logPath) => {
    assert.deepEqual(await discoverMcpConfig(configPath), []);
    assert.equal((await messages(logPath)).some((message) => message.method === "tools/list"), false);
  });
});

test("MCP discovery rejects unsupported protocol versions", async () => {
  await withServer("unsupported-version", async (configPath) => {
    await assert.rejects(discoverMcpConfig(configPath), /unsupported protocol version 2099-01-01/);
  });
});

test("MCP discovery enforces one total timeout", async () => {
  await withServer("hang", async (configPath) => {
    await assert.rejects(discoverMcpConfig(configPath, 100), /timed out after 100ms/);
  });
});

test("MCP discovery reports a successful premature exit promptly", async () => {
  await withServer("exit-zero", async (configPath) => {
    const started = Date.now();
    await assert.rejects(discoverMcpConfig(configPath, 2_000), /exited with code 0 before discovery completed/);
    assert.ok(Date.now() - started < 1_000);
  });
});

test("MCP discovery only performs initialize and tools/list", async () => {
  await withServer("single", async (configPath, logPath) => {
    const tools = await discoverMcpConfig(configPath);
    assert.equal(tools[0]?.id, "mcp.fixture.search");
    assert.equal((await messages(logPath)).some((message) => message.method === "tools/call"), false);
  });
});
