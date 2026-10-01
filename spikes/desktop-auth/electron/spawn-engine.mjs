// Electron main that starts the "Engine" itself and hands it one end of a
// socketpair on fd 3 (Node's stdio 'pipe' is a socketpair on macOS). The
// channel has no path, so no other process can connect to it.
import { app } from 'electron';
import { spawn } from 'node:child_process';

app.dock?.hide();
const child = spawn(process.env.SPIKE_NODE, [process.env.SPIKE_CHILD, process.env.SPIKE_ADDON], {
  stdio: ['ignore', 'inherit', 'inherit', 'pipe'],
  env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
});
const chan = child.stdio[3];
let buf = '';
chan.on('data', (d) => {
  buf += d.toString('utf8');
  if (buf.includes('\n')) process.stdout.write(JSON.stringify({ event: 'socketpair', mainPid: process.pid, childReport: JSON.parse(buf.slice(0, buf.indexOf('\n'))) }) + '\n');
});
chan.write(JSON.stringify({ hello: 'desktop', mainPid: process.pid }) + '\n');
child.on('exit', (code) => app.exit(code ?? 1));
