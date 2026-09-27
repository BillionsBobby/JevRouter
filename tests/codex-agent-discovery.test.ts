import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodexAgents } from "../src/discovery.js";

test("rejects Codex agent names that normalize to the same candidate ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevrouter-codex-agents-"));
  try {
    await Promise.all([
      writeFile(join(root, "hyphenated.toml"), 'name = "code-review"\ndescription = "Hyphenated reviewer"\n'),
      writeFile(join(root, "underscored.toml"), 'name = "code_review"\ndescription = "Underscored reviewer"\n'),
    ]);

    await assert.rejects(discoverCodexAgents(root), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /codex_agent\.code_review/);
      assert.match(error.message, /code-review/);
      assert.match(error.message, /code_review/);
      assert.match(error.message, /hyphenated\.toml/);
      assert.match(error.message, /underscored\.toml/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
