'use strict';
// The desktop's side: connect to whatever listens on the Engine socket and
// check the peer's code signature (desktop-auth spike's peer addon).
//   check-peer.cjs <peer.node> <sock> <requirement>...
const net = require('node:net');

const [addonPath, sock, ...reqs] = process.argv.slice(2);
const m = { exports: {} };
process.dlopen(m, addonPath);
const s = net.connect(sock, () => {
  const fd = s._handle && s._handle.fd;
  const results = reqs.map((r) => m.exports.checkByToken(fd, r));
  process.stdout.write(JSON.stringify(results.map((r) => ({ valid: r.valid, identifier: r.identifier ?? null, teamId: r.teamId ?? null }))) + '\n');
  s.destroy();
});
s.on('error', (e) => {
  process.stdout.write(JSON.stringify({ error: e.message }) + '\n');
  process.exitCode = 1;
});
