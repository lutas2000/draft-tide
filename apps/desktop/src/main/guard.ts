// Imported first by main.ts, before any other module runs. Launching the real
// app with a debugging switch lets any same-user process drive the GUI
// renderer, and through it the desktop channel; signing and the peer check
// cannot tell (desktop-auth spike B1, R6). Refuse and exit. Review this list
// on every Electron upgrade. The fuses separately keep RunAsNode, NODE_OPTIONS
// and the inspect arguments off in packaged builds.
import { app } from 'electron';
import { BUILD } from './build-info.ts';

const REFUSED_PREFIXES = ['--remote-debugging-', '--inspect', '--js-flags', '--debug'];
const REFUSED_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-publish-uid',
  'js-flags',
];

if (!BUILD.allowDebugSwitches) {
  const fromArgv = process.argv.slice(1).find((arg) => REFUSED_PREFIXES.some((p) => arg.toLowerCase().startsWith(p)));
  const fromCommandLine = REFUSED_SWITCHES.find((s) => app.commandLine.hasSwitch(s));
  const refused = fromArgv ?? (fromCommandLine ? `--${fromCommandLine}` : undefined);
  if (refused !== undefined) {
    process.stderr.write(`Draft Tide: refusing to start with the debugging switch ${refused.split('=')[0] ?? ''}\n`);
    process.exit(1);
  }
}
