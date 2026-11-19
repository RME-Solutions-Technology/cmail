#!/usr/bin/env bash
# The local PR gate: the same checks as .github/workflows ci.yml and e2e.yml, run in WSL.
# Usage: bash scripts/wsl/test.sh <ref> [--only validate|collector|e2e] [--nodes "22 24 26"] [--repo <git url>]
#   <ref>  a branch, tag or commit (fetched from the repo, default origin of this checkout).
# Work happens in a fresh copy under ~/cmail-gate (ext4, not /mnt/c). Never touches your checkout.
# Heavy: take the heavy lock first (the Windows launcher _work\cmail-build\wsl-gate.sh does).
# NOT covered here: CodeQL (needs GitHub's hosted analysis; it stays a GitHub check, and is blocked while Actions is).
set -euo pipefail
REF=${1:?usage: test.sh <ref> [--only ...] [--nodes ...]}; shift || true
ONLY=all; NODES="22 24 26"; REPO=${CMAIL_REPO_URL:-https://github.com/RME-Solutions-Technology/cmail.git}
while [ $# -gt 0 ]; do case "$1" in --only) ONLY=$2; shift 2;; --nodes) NODES=$2; shift 2;; --repo) REPO=$2; shift 2;; *) echo "unknown $1"; exit 2;; esac; done
export PATH="$HOME/.local/share/fnm:$HOME/.local/bin:$PATH"; eval "$(fnm env --shell bash)"
W=$HOME/cmail-gate
[ -d "$W/.git" ] || git clone -q "$REPO" "$W"
cd "$W"; git remote set-url origin "$REPO"; git fetch -q origin "+refs/heads/*:refs/remotes/origin/*" --tags
git checkout -q --detach "$(git rev-parse --verify -q "origin/$REF" || git rev-parse "$REF")"; git clean -fdxq -e node_modules
echo "gate: $(git rev-parse --short HEAD) ($REF)"
fail=0; step() { echo; echo "== $*"; }
if [ "$ONLY" = all ] || [ "$ONLY" = validate ]; then
  for n in $NODES; do
    step "Validate on Node $n (pnpm install --frozen-lockfile; pnpm release:check)"
    fnm exec --using="$n" bash -c 'node -v && pnpm install --frozen-lockfile >/dev/null && pnpm release:check' || { echo "FAIL validate node $n"; fail=1; }
  done
fi
if [ "$ONLY" = all ] || [ "$ONLY" = collector ]; then
  step "Mailbox access collector harness (PowerShell $(pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'))"
  pwsh -NoProfile -NonInteractive -File apps/email-worker/container/m365-perms/collect.Tests.ps1 || { echo FAIL collector; fail=1; }
  pwsh -NoProfile -NonInteractive -File scripts/onboarding/onboarding.Tests.ps1 || { echo FAIL onboarding; fail=1; }
fi
if [ "$ONLY" = all ] || [ "$ONLY" = e2e ]; then
  step "axe + smoke, perf budgets, Focused Inbox (Node 24)"
  fnm exec --using=24 bash -c '
    set -e; pnpm install --frozen-lockfile >/dev/null
    pnpm exec playwright install --with-deps chromium >/dev/null
    pnpm exec playwright test e2e/mobile/a11y.spec.ts e2e/mobile/smoke.spec.ts --project=pixel-7 --project=desktop-chrome
    E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/mobile/perf.spec.ts --project=pixel-7 --workers=1
    E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/mobile/focused-inbox.spec.ts --project=focused-inbox --no-deps --workers=1
  ' || { echo "FAIL e2e"; fail=1; }
fi
echo; [ "$fail" = 0 ] && echo "GATE PASS $(git rev-parse --short HEAD)" || { echo "GATE FAIL"; exit 1; }
