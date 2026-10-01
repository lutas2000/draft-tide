// Electron main that connects to the stand-in Engine, so the server sees an
// Electron main process as its peer (as the desktop channel would).
import { app } from 'electron';
import { connect } from 'node:net';

app.dock?.hide();
const s = connect(process.env.SPIKE_SOCKET, () => s.write(JSON.stringify({ label: process.env.SPIKE_LABEL, pid: process.pid }) + '\n'));
s.on('data', (d) => {
  process.stdout.write(d);
  s.end();
  app.exit(0);
});
s.on('error', (e) => {
  process.stderr.write(String(e) + '\n');
  app.exit(2);
});
