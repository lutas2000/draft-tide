'use strict';
// What another process can do when it runs code on a Node it controls:
//   reader.cjs read <addon>   read the Engine's keychain item, no UI allowed
//   reader.cjs serve <sock>   pose as the Engine on a socket
const crypto = require('node:crypto');
const net = require('node:net');

const SERVICE = 'dev.drafttide.spike.token-custody';
const ACCOUNT = 'github';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'read') {
  try {
    const m = { exports: {} };
    process.dlopen(m, arg);
    const r = m.exports.read(SERVICE, ACCOUNT, false);
    out({ status: r.status, message: r.message, sha256: r.data ? crypto.createHash('sha256').update(r.data).digest('hex') : null });
  } catch (e) {
    out({ loadError: String(e?.message ?? e) });
  }
} else if (cmd === 'serve') {
  const server = net.createServer((s) => s.end('fake engine\n'));
  server.listen(arg, () => out({ ready: true, pid: process.pid }));
} else {
  out({ error: 'usage: reader.cjs read <addon> | serve <sock>' });
  process.exitCode = 2;
}
