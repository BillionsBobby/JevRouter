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
      writeFile(join(root, "hyphenated.toml"), 'name = "code-review"\ndescription = "Hyphenated reviewer"\ndeveloper_instructions = "Review code"\n'),
      writeFile(join(root, "underscored.toml"), 'name = "code_review"\ndescription = "Underscored reviewer"\ndeveloper_instructions = "Review code"\n'),
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

test("discovers valid multiline TOML descriptions without exporting private instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevrouter-codex-agents-"));
  try {
    await writeFile(join(root, "reviewer.toml"), [
      'name = "reviewer"',
      'description = """',
      'Reviews code for correctness,',
      'including multiline cases."""',
      'developer_instructions = """',
      'PRIVATE_INSTRUCTION_MARKER',
      '"""',
    ].join("\n"));

    const candidates = await discoverCodexAgents(root);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].description, "Reviews code for correctness,\nincluding multiline cases.");
    assert.equal(candidates[0].availability?.available, true);
    assert.doesNotMatch(JSON.stringify(candidates), /PRIVATE_INSTRUCTION_MARKER|developer_instructions/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not expose profiles with missing or non-string developer instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevrouter-codex-agents-"));
  try {
    await Promise.all([
      writeFile(join(root, "missing.toml"), 'name = "missing"\ndescription = "Missing instructions"\n'),
      writeFile(join(root, "wrong-type.toml"), 'name = "wrong-type"\ndescription = "Invalid instructions"\ndeveloper_instructions = 42\n'),
      writeFile(join(root, "empty.toml"), 'name = "empty"\ndescription = "Empty instructions"\ndeveloper_instructions = ""\n'),
    ]);

    assert.deepEqual(await discoverCodexAgents(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
