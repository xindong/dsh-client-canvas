// Keep the official launcher's authenticated URL for duplicate starts.
// Do not disable authentication or reuse a URL belonging to an old process.
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cli, runtimeDir, ...args] = process.argv.slice(2);
const child = spawn(process.execPath, [cli, 'web', ...args], {
  stdio: ['inherit', 'pipe', 'inherit'],
});
let pending = '';
function inspect(line) {
  const match = line.match(/^dsh web: (https?:\/\/\S+)/);
  if (!match || !child.pid) return;
  try {
    mkdirSync(runtimeDir, { recursive: true });
    const target = join(runtimeDir, 'web-address.json');
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pid: child.pid, url: match[1] }) + '\n', { mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    console.error(`Could not save DSH login address: ${error.message}`);
  }
}
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf('\n')) !== -1) {
    inspect(pending.slice(0, newline).replace(/\r$/, ''));
    pending = pending.slice(newline + 1);
  }
  if (pending.length > 65536) pending = pending.slice(-8192);
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(`Could not start DSH: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (pending) inspect(pending);
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
});
