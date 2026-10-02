'use strict';
// Stand-in Engine, built into a Node SEA. The modes exist only so the suite
// can drive it; the real Engine takes no such commands and never prints a
// secret. Addons are loaded from beside the executable, never from a path
// given by argv or the environment.
const crypto = require('node:crypto');
const fs = require('node:fs');
const inspector = require('node:inspector');
const net = require('node:net');
const path = require('node:path');

const BUILD = '__BUILD__'; // replaced per build, so two builds differ in code
const SERVICE = 'dev.drafttide.spike.token-custody';
const ACCOUNT = 'github';

// The Engine refuses to run in an environment it did not expect. Node reads
// some variables before any of this code runs (NODE_EXTRA_CA_CERTS) and some
// on use (NODE_TLS_REJECT_UNAUTHORIZED, NODE_USE_ENV_PROXY); an allowlist is
// the only form that covers variables nobody has listed yet.
// CoreFoundation adds __CF_USER_TEXT_ENCODING to every process it starts in,
// even one spawned with an empty environment.
const ALLOWED = new Set(['HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING']);

const mode = process.argv[2] ?? 'probe';
const raw = mode.startsWith('raw-'); // spike only: skip the guard to show what Node itself honors
const cmd = raw ? mode.slice(4) : mode;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (!raw) {
  const extra = Object.keys(process.env).filter((k) => !ALLOWED.has(k));
  if (extra.length) {
    out({ refused: 'unexpected-environment', keys: extra.sort() });
    process.exit(78);
  }
}

const beside = (name) => path.join(path.dirname(process.execPath), name);
function addon(name) {
  const m = { exports: {} };
  process.dlopen(m, beside(name));
  return m.exports;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function main() {
  switch (cmd) {
    case 'probe':
      return out({ build: BUILD, argv: process.argv.slice(3), execArgv: process.execArgv, evil: globalThis.__evil === true, inspector: inspector.url() ?? null });
    case 'store': {
      const secret = fs.readFileSync(0);
      const kc = addon('keychain.node');
      kc.remove(SERVICE, ACCOUNT);
      return out({ build: BUILD, status: kc.store(SERVICE, ACCOUNT, secret) });
    }
    case 'read': {
      const r = addon('keychain.node').read(SERVICE, ACCOUNT, false);
      return out({ build: BUILD, status: r.status, message: r.message, sha256: r.data ? sha(r.data) : null });
    }
    case 'remove':
      return out({ build: BUILD, status: addon('keychain.node').remove(SERVICE, ACCOUNT) });
    case 'tls':
      try {
        const res = await fetch(process.argv[3]);
        return out({ ok: true, status: res.status });
      } catch (e) {
        return out({ ok: false, error: String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e) });
      }
    case 'sqlite': {
      const db = addon('better_sqlite3.node');
      return out({ loaded: typeof db.Database === 'function' });
    }
    case 'serve': {
      const server = net.createServer((s) => s.end('engine\n'));
      server.listen(process.argv[3], () => out({ ready: true, pid: process.pid }));
      return;
    }
    default:
      out({ error: `unknown mode ${cmd}` });
      process.exitCode = 2;
  }
}

main().catch((e) => {
  out({ error: String(e?.message ?? e) });
  process.exitCode = 1;
});
