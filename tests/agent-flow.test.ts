import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupAgents, doctorAgents, resolveHostCommand, AGENT_HOST_COMMANDS } from '../src/agent-setup.js';
import { providerConfiguration, createProvider } from '../src/runtime.js';

const root = resolve('.');
const cli = join(root, 'dist/cli.js');
const stub = join(root, 'tests/fixtures/provider-stub.mjs');
async function project() {
  await mkdir(join(root, '.test-artifacts'), { recursive: true });
  return mkdtemp(join(root, '.test-artifacts/project-'));
}
function environment(extra: NodeJS.ProcessEnv = {}) {
  return { ...process.env, JEV_API_KEY: '', TYPESAFE_API_KEY: '', OPENROUTER_API_KEY: '', JEV_ROUTER_PROVIDER: '', ...extra };
}
function run(cwd: string, args: string[], input?: string, env = environment({ JEV_API_KEY: 'fixture-key' })) {
  return spawnSync(process.execPath, ['--import', stub, cli, ...args], { cwd, input, env, encoding: 'utf8', timeout: 20_000 });
}
const task = { request: 'Find the latest interview original source before summarizing', candidates: [
  { name: 'search_web', description: 'Search for current web sources' },
  { name: 'summarize', description: 'Summarize sources already retrieved' },
] };

test('one command installs CLI Skill for all hosts, checks Jev, and keeps existing project instructions', async () => {
  const cwd = await project();
  const original = '# Local rules\nPreserve every user file.\n';
  await writeFile(join(cwd, 'AGENTS.md'), original, { flag: 'wx' });
  await writeFile(join(cwd, 'CLAUDE.md'), original, { flag: 'wx' });
  await writeFile(join(cwd, '.cursorrules'), original, { flag: 'wx' });
  const result = run(cwd, ['agent', 'setup']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /CHECK passed/);
  const output = JSON.parse(result.stdout);
  assert.equal(output.check.model, 'fixture-jev');
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) assert.ok((await readFile(join(cwd, name), 'utf8')).startsWith(original));
  assert.equal((await readdir(cwd)).filter(name => name.includes('backup')).length, 3);
  for (const prefix of ['.agents', '.claude', '.cursor']) {
    const file = await readFile(join(cwd, prefix, 'skills/jevrouter/SKILL.md'), 'utf8');
    assert.ok(file.startsWith('---\nname: jevrouter'));
    assert.ok(!file.includes('{{JEVROUTER_COMMAND}}'));
    assert.ok(!file.includes('fixture-key'));
  }
  await assert.rejects(stat(join(cwd, '.mcp.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(cwd, '.codex/config.toml')), { code: 'ENOENT' });
  await assert.rejects(stat(join(cwd, '.cursor/mcp.json')), { code: 'ENOENT' });
  const receipt = JSON.parse(await readFile(join(cwd, '.jevrouter/integration-v2.json'), 'utf8'));
  assert.equal(receipt.key, 'JEV_API_KEY');
  // The second run is idempotent: no duplicate instructions or backups.
  const before = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
  assert.equal(run(cwd, ['agent', 'setup']).status, 0);
  assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), before);
  assert.equal((await readdir(cwd)).filter(name => name.includes('backup')).length, 3);
  const check = run(cwd, ['agent', 'doctor']);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).configuration.every((c: { configured: boolean }) => c.configured), true);
});

test('installed Skill helper runs routing from another cwd, with start/end and a provider response receipt', async () => {
  const cwd = await project();
  assert.equal(run(cwd, ['agent', 'setup']).status, 0);
  const helper = join(cwd, '.agents/skills/jevrouter/scripts/route.mjs');
  const result = spawnSync(process.execPath, [helper, 'route', '--stdin'], {
    cwd: root, input: JSON.stringify(task), env: environment({ JEV_API_KEY: 'fixture-key', NODE_OPTIONS: `--import=${stub}` }), encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /JevRouter START/);
  assert.match(result.stderr, /JevRouter END.*decision_id=/);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.decision.selected, 'search_web');
  assert.equal(receipt.raw_jev.model, 'fixture-jev');
  assert.equal(receipt.runtime.cache, false);
  assert.equal(receipt.decision.candidates.length, 2);
  assert.ok(receipt.saved_to.startsWith(cwd));
  assert.equal(JSON.parse(await readFile(receipt.saved_to, 'utf8')).decision_id, receipt.decision_id);
});

test('no key, empty candidates, malformed input and rejected credentials fail visibly without simulated success', async () => {
  const cwd = await project();
  for (const input of ['null', '{}', JSON.stringify({ request: 'x', candidates: [] }), '{']) {
    assert.equal(run(cwd, ['route', '--stdin'], input).status, 1);
  }
  const missing = run(cwd, ['route', '--stdin'], JSON.stringify(task), environment());
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing JEV_API_KEY/);
  const denied = run(cwd, ['agent', 'setup'], undefined, environment({ JEV_API_KEY: 'wrong' }));
  assert.equal(denied.status, 1);
  await assert.rejects(stat(join(cwd, 'AGENTS.md')), { code: 'ENOENT' });
});

test('agent start explains secure interactive key entry when no terminal credentials exist', async () => {
  const cwd = await project();
  const result = run(cwd, ['agent', 'start', '--agent', 'codex'], undefined, environment());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /enter a key securely/);
});

test('provider configuration respects Jev aliases and does not borrow another provider key', () => {
  assert.deepEqual(providerConfiguration('typesafe', { JEV_API_KEY: 'a' }), { provider: 'typesafe', key: 'JEV_API_KEY' });
  assert.deepEqual(providerConfiguration(undefined, { OPENROUTER_API_KEY: 'b' }), { provider: 'openrouter', key: 'OPENROUTER_API_KEY' });
  assert.equal(providerConfiguration('openrouter', { JEV_API_KEY: 'a' }).key, 'OPENROUTER_API_KEY');
  assert.throws(() => createProvider('unknown'), /provider must/);
});

test('Codex active override gets appended, legacy MCP configs remain byte-identical by default', async () => {
  const cwd = await project();
  await writeFile(join(cwd, 'AGENTS.override.md'), '# Active override\n', { flag: 'wx' });
  await mkdir(join(cwd, '.codex'));
  const old = '[mcp_servers.jevrouter]\ncommand="old-runner"\n';
  await writeFile(join(cwd, '.codex/config.toml'), old, { flag: 'wx' });
  await setupAgents('codex', cwd, 'openrouter');
  assert.equal(await readFile(join(cwd, '.codex/config.toml'), 'utf8'), old);
  assert.match(await readFile(join(cwd, 'AGENTS.override.md'), 'utf8'), /\.agents\/skills\/jevrouter/);
  await assert.rejects(stat(join(cwd, 'AGENTS.md')), { code: 'ENOENT' });
  const check = await doctorAgents('codex', cwd, 'typesafe');
  assert.equal(check[0].configured, false);
});

test('optional MCP never overwrites unrelated config and does not replace the host base prompt', async () => {
  const cwd = await project();
  await writeFile(join(cwd, '.mcp.json'), '{"mcpServers":{"user":{"command":"local"}}}\n', { flag: 'wx' });
  await assert.rejects(setupAgents('claude', cwd, 'openrouter', { withMcp: true }), /Existing file preserved/);
  assert.equal(await readFile(join(cwd, '.mcp.json'), 'utf8'), '{"mcpServers":{"user":{"command":"local"}}}\n');
});

test('JSON/YAML candidates match the stdin request route', async () => {
  const cwd = await project();
  await writeFile(join(cwd, 'tools.yaml'), 'candidates:\n  - name: search_web\n    description: Find current web sources\n  - name: summarize\n    description: Summarize retrieved sources\n', { flag: 'wx' });
  const result = run(cwd, ['route', '--request', task.request, '--candidates-file', 'tools.yaml']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision.selected, 'search_web');
  const duplicate = run(cwd, ['route', '--stdin'], JSON.stringify({ ...task, candidates: [task.candidates[0], task.candidates[0]] }));
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /unique/);
});

test('agent start launches the host only after checking Jev and carries the key without serializing it', async () => {
  const cwd = await project();
  const bin = join(cwd, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\nconsole.log(JSON.stringify({host_started:true,key_present:Boolean(process.env.JEV_API_KEY),args:process.argv.slice(2)}));\n`, { flag: 'wx', mode: 0o700 });
  const result = run(cwd, ['agent', 'start', '--agent', 'codex', '--request', 'choose the next step'], undefined, environment({ JEV_API_KEY: 'fixture-key', PATH: `${bin}:${process.env.PATH}` }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /CHECK passed/);
  assert.match(result.stderr, /START host=codex/);
  assert.match(result.stdout, /"host_started":true,"key_present":true/);
  assert.ok(!result.stdout.includes('fixture-key'));
  assert.ok(!result.stderr.includes('fixture-key'));
  const invalid = run(cwd, ['agent', 'start', '--agent', 'codex'], undefined, environment({ JEV_API_KEY: 'wrong', PATH: `${bin}:${process.env.PATH}` }));
  assert.equal(invalid.status, 1);
  assert.ok(!invalid.stdout.includes('host_started'));
});

test('doctor checks configuration without claiming authentication; missing key produces failure exit', async () => {
  const cwd = await project();
  assert.equal(run(cwd, ['agent', 'setup']).status, 0);
  const missing = run(cwd, ['agent', 'doctor'], undefined, environment());
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).configuration[0].scope, 'local_configuration_only');
  assert.equal(JSON.parse(missing.stdout).live, null);
  const probe = run(cwd, ['agent', 'doctor', '--live']);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(JSON.parse(probe.stdout).live.purpose, 'connection_check');
});

test('review outcomes have nonzero exit codes and explicit demo provenance', async () => {
  const cwd = await project();
  const result = run(cwd, ['route', '--provider', 'demo', '--stdin'], JSON.stringify({ request: 'unclear', candidates: [{name:'a',description:'one'},{name:'b',description:'two'}] }));
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).status, 'no_decision');
  assert.equal(JSON.parse(result.stdout).runtime.source, 'demo');
  assert.match(result.stderr, /END status=no_decision/);
});

test('setup handles project paths with spaces and quotes', async () => {
  const base = await project();
  const cwd = join(base, "User's Project");
  await mkdir(cwd);
  assert.equal(run(cwd, ['agent', 'setup']).status, 0);
  const result = spawnSync(process.execPath, [join(cwd, '.agents/skills/jevrouter/scripts/route.mjs'), 'route', '--stdin'], { cwd:base, input:JSON.stringify(task), env:environment({JEV_API_KEY:'fixture-key',NODE_OPTIONS:`--import=${stub}`}), encoding:'utf8', timeout:20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision.selected,'search_web');
});

test('agent setup and doctor support Cursor host with .cursorrules and .cursor/mcp.json', async () => {
  const cwd = await project();
  const result = run(cwd, ['agent', 'setup', '--agent', 'cursor', '--with-mcp']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(await readFile(join(cwd, '.cursorrules'), 'utf8'));
  const skill = await readFile(join(cwd, '.cursor/skills/jevrouter/SKILL.md'), 'utf8');
  assert.ok(skill.includes('name: jevrouter'));
  const mcp = JSON.parse(await readFile(join(cwd, '.cursor/mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers.jevrouter);
  const doctor = run(cwd, ['agent', 'doctor', '--agent', 'cursor']);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).configuration[0].configured, true);
});

test('resolveHostCommand maps agent targets to their real CLI commands', () => {
  assert.deepEqual(AGENT_HOST_COMMANDS.codex, ['codex']);
  assert.deepEqual(AGENT_HOST_COMMANDS.claude, ['claude']);
  assert.deepEqual(AGENT_HOST_COMMANDS.cursor, ['agent', 'cursor-agent']);
  assert.equal(resolveHostCommand('codex'), 'codex');
  assert.equal(resolveHostCommand('claude'), 'claude');
  assert.equal(resolveHostCommand('cursor', { PATH: '' }), 'agent');
});

test('regression: agent start --agent cursor executes Cursor Agent CLI (agent or legacy cursor-agent), not desktop binary', async () => {
  const cwd = await project();
  const bin = join(cwd, 'bin');
  await mkdir(bin);

  // Modern Cursor Agent CLI binary: 'agent'
  await writeFile(join(bin, 'agent'), `#!${process.execPath}\nconsole.log(JSON.stringify({command:'agent',args:process.argv.slice(2)}));\n`, { flag: 'wx', mode: 0o700 });
  const resultAgent = run(cwd, ['agent', 'start', '--agent', 'cursor', '--request', 'test routing'], undefined, environment({ JEV_API_KEY: 'fixture-key', PATH: `${bin}:${process.env.PATH}` }));
  assert.equal(resultAgent.status, 0, resultAgent.stderr);
  assert.match(resultAgent.stderr, /CHECK passed/);
  assert.match(resultAgent.stderr, /START host=cursor/);
  assert.match(resultAgent.stdout, /"command":"agent"/);

  // Legacy Cursor Agent CLI binary: 'cursor-agent'
  const legacyCwd = await project();
  const legacyBin = join(legacyCwd, 'bin');
  await mkdir(legacyBin);
  await writeFile(join(legacyBin, 'cursor-agent'), `#!${process.execPath}\nconsole.log(JSON.stringify({command:'cursor-agent',args:process.argv.slice(2)}));\n`, { flag: 'wx', mode: 0o700 });
  const resultLegacy = run(legacyCwd, ['agent', 'start', '--agent', 'cursor', '--request', 'test routing'], undefined, environment({ JEV_API_KEY: 'fixture-key', PATH: `${legacyBin}:${process.env.PATH}` }));
  assert.equal(resultLegacy.status, 0, resultLegacy.stderr);
  assert.match(resultLegacy.stderr, /CHECK passed/);
  assert.match(resultLegacy.stderr, /START host=cursor/);
  assert.match(resultLegacy.stdout, /"command":"cursor-agent"/);
});


