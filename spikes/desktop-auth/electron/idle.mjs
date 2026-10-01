// Electron main that just stays up for a while. With SPIKE_GUARD=1 it first
// refuses the switches that let another process drive the app.
import { app } from 'electron';

const REFUSED = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port', 'js-flags'];
if (process.env.SPIKE_GUARD === '1') {
  for (const sw of REFUSED) {
    if (app.commandLine.hasSwitch(sw)) {
      process.stderr.write(`refusing to start with --${sw}\n`);
      process.exit(3);
    }
  }
}
app.dock?.hide();
process.stdout.write(JSON.stringify({ event: 'up', pid: process.pid }) + '\n');
setTimeout(() => app.exit(0), Number(process.env.SPIKE_IDLE_MS ?? 4000));
