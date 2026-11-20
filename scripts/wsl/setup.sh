#!/usr/bin/env bash
# One-time (and safe to repeat) setup of a WSL Ubuntu for the cmail gate and deploys.
# Installs, with no changes to the Windows side: fnm + Node 22/24/26, pnpm (the version
# pinned in package.json), PowerShell 7.6.10 (collector harness) and Chromium for Playwright.
# Needs passwordless sudo for apt only. Usage: bash scripts/wsl/setup.sh
set -euo pipefail
export PATH="$HOME/.local/share/fnm:$HOME/.local/bin:$PATH"
if ! command -v fnm >/dev/null; then
  curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
fi
eval "$(fnm env --shell bash)"
for v in 22 24 26; do fnm install "$v"; done
fnm default 24
PNPM=$(sed -n 's/.*"packageManager": "pnpm@\([0-9.]*\)".*/\1/p' "$(dirname "$0")/../../package.json")
npm install -g "pnpm@${PNPM}" --prefix "$HOME/.local"
if ! command -v pwsh >/dev/null; then
  . /etc/os-release
  wget -q -O /tmp/ms-prod.deb "https://packages.microsoft.com/config/ubuntu/${VERSION_ID}/packages-microsoft-prod.deb" || true
  sudo -n dpkg -i /tmp/ms-prod.deb && sudo -n apt-get update -qq
  sudo -n apt-get install -y --allow-downgrades "powershell=7.6.10-1.deb" || sudo -n apt-get install -y powershell
fi
sudo -n apt-get install -y git curl ca-certificates python3 >/dev/null
echo "setup ok: node $(fnm exec --using=24 node -v), pnpm $(pnpm -v), pwsh $(pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' 2>/dev/null || echo missing)"
