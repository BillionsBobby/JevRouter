// Native Windows test executables are copies of Node, preloaded with this fixture.
import { basename } from 'node:path';

const command = basename(process.execPath, '.exe');
if (['codex', 'agent', 'cursor-agent'].includes(command)) {
  console.log(JSON.stringify({
    host_started: true,
    key_present: Boolean(process.env.JEV_API_KEY),
    command,
    args: process.argv.slice(1),
  }));
  process.exit(0);
}
