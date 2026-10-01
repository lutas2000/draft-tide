#!/bin/bash
# Prepares Claude Code on the web sessions: Node 24 (the workspace needs
# >=24.11 <25) plus the M1 pnpm workspace. The throwaway spikes keep their own
# installs (see each spike's README); they are not set up here.
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
# No desktop GUI in a web session: skip the Electron binary download.
(cd "$CLAUDE_PROJECT_DIR" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 corepack pnpm install >&2)
