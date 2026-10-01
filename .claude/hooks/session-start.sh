#!/bin/bash
# Prepares Claude Code on the web sessions: Node 24 (the spikes need >=24.11 <25)
# plus the M0 spike dependencies. spikes/single-repo reuses m0/core's toolchain.
# Replace the install steps once the M1 pnpm workspace exists.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

export NVM_DIR="${NVM_DIR:-/opt/nvm}"
# nvm.sh is not written for `set -u`.
set +u
. "$NVM_DIR/nvm.sh"
nvm install 24 >&2
nvm use 24 >&2
set -u

NODE_BIN="$(dirname "$(nvm which 24)")"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$NODE_BIN:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  echo "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0" >> "$CLAUDE_ENV_FILE"
fi

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
for dir in spikes/m0/core spikes/m0/gui; do
  (cd "$CLAUDE_PROJECT_DIR/$dir" && corepack pnpm install >&2)
done
