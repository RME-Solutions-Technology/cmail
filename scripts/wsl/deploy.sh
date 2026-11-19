#!/usr/bin/env bash
# Deploy one instance (email worker first, then Pages) from WSL, with rollback ids, smoke tests and
# automatic rollback. Same steps as the maintainers' Git Bash deploy; this is the normal path.
# Usage: bash scripts/wsl/deploy.sh <instance> <sha> "<review line>"
# Needs CLOUDFLARE_API_TOKEN in the environment (pass it in from Windows with WSLENV; never print it) and
# CMAIL_INSTANCES_FILE: a bash file that sets, per instance <i>:  ACCT[<i>]=<cloudflare account id>
#   HOST[<i>]=<public host>  CLONE[<i>]=<dir with that instance's untracked wrangler.toml files>
# and (optional) CMAIL_DEPLOY_LOG. CMAIL_DRY=1 stops before deploying, after the checks and rollback ids.
set -uo pipefail
INST=${1:?instance}; SHA=${2:?sha}; REVIEW=${3:?review line}
declare -A ACCT HOST CLONE
# shellcheck disable=SC1090
source "${CMAIL_INSTANCES_FILE:?set CMAIL_INSTANCES_FILE}"
LOG=${CMAIL_DEPLOY_LOG:-$HOME/cmail-deploy.log}
export CLOUDFLARE_ACCOUNT_ID=${ACCT[$INST]:?unknown instance}
export PATH="$HOME/.local/share/fnm:$HOME/.local/bin:$PATH"; eval "$(fnm env --shell bash)"; fnm use 24 >/dev/null
# The Docker-backed RME worker: wrangler runs docker as this user; use sudo when the socket is not ours.
if ! docker ps >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1; then
  printf '#!/bin/sh\nexec sudo -n docker "$@"\n' > "$HOME/.local/bin/docker-sudo"; chmod +x "$HOME/.local/bin/docker-sudo"
  export WRANGLER_DOCKER_BIN="$HOME/.local/bin/docker-sudo"
fi
PROJ=cmail-$INST-web
log() { echo "$(date +%Y-%m-%dT%H:%M:%S%z) $INST $*" | tee -a "$LOG"; }
die() { log "STOP: $*"; exit 1; }
REPO=${CMAIL_REPO_URL:-https://github.com/RME-Solutions-Technology/cmail.git}
D=$HOME/cmail-deploy-$INST
[ -d "$D/.git" ] || git clone -q "$REPO" "$D"
cd "$D" || die "no work copy"
git fetch -q origin --tags && git checkout -q --detach "$SHA" || die "cannot check out $SHA"
[ "$(git rev-parse --short HEAD)" = "${SHA:0:7}" ] || die "HEAD is not $SHA"
git clean -fdxq -e node_modules  # no leftover configs or build output from an earlier run
# Instance configs are not in git. Copy them from the instance's clone; the two main ones must exist.
for f in apps/email-worker/wrangler.toml apps/web/wrangler.toml; do
  [ -f "${CLONE[$INST]}/$f" ] || die "missing ${CLONE[$INST]}/$f"
  cp "${CLONE[$INST]}/$f" "$f"
done
[ -f "${CLONE[$INST]}/apps/backup-worker/wrangler.toml" ] && cp "${CLONE[$INST]}/apps/backup-worker/wrangler.toml" apps/backup-worker/wrangler.toml
pnpm install --frozen-lockfile >/dev/null 2>&1 || die "pnpm install failed"
W="$D/node_modules/.bin/wrangler"
pending=$($W d1 migrations list DB --remote --config apps/web/wrangler.toml 2>&1)
echo "$pending" | grep -q "No migrations to apply" || die "D1 migrations pending: needs a yes, not deploying"
latest() { (cd apps/email-worker && $W deployments list --json 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print(sorted(d,key=lambda x:x['created_on'])[-1]['versions'][0]['version_id'])"); }
prevWorker=$(latest)
prevPages=$($W pages deployment list --project-name "$PROJ" --environment production --json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['Id'])")
[ -n "$prevWorker" ] && [ -n "$prevPages" ] || die "could not read rollback ids"
if [ "${CMAIL_DRY:-}" = 1 ]; then log "DRY RUN ok: $SHA installs, no migrations pending, rollback worker $prevWorker, pages $prevPages. Nothing deployed."; exit 0; fi
log "deploy $SHA start (WSL); rollback worker $prevWorker, pages $prevPages; $REVIEW"
smoke() {
  local h=${HOST[$INST]} root mail mcp prm rewrites enc
  root=$(curl -s -o /dev/null -w '%{http_code}' "https://$h/")
  mail=$(curl -s -o /dev/null -w '%{http_code}' "https://$h/mail")
  mcp=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' "https://$h/mcp")
  prm=$(curl -s -o /dev/null -w '%{http_code}' "https://$h/.well-known/oauth-protected-resource/mcp")
  rewrites=$(curl -s "https://$h/privacy" | grep -c '__cf_email__\|email-decode.min.js')
  enc=$(curl -s -D - -o /dev/null -H 'Accept-Encoding: br, gzip' "https://$h/privacy" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-encoding"{print $2}')
  log "smoke: / $root, /mail $mail, /mcp $mcp, protected-resource $prm, rewrites $rewrites, encoding ${enc:-none}"
  [ "$root" = 200 ] && { [ "$mail" = 302 ] || [ "$mail" = 303 ]; } && [ "$mcp" = 401 ] && [ "$prm" = 200 ] && [ "$rewrites" = 0 ]
}
rollback_worker() {
  if (cd apps/email-worker && $W rollback "$prevWorker" --message "auto rollback $SHA" -y >/dev/null 2>&1); then log "ROLLED BACK worker to $prevWorker"
  else log "ROLLBACK FAILED: worker is still $(latest); roll back by hand to $prevWorker"; fi
}
# A Docker-backed worker can come back half-applied; wrangler says to run the same deploy again, once.
(cd apps/email-worker && $W deploy --message "cmail $SHA" >/tmp/cmail-$INST-worker.out 2>&1) \
  || { grep -q "not fully applied" /tmp/cmail-$INST-worker.out && (cd apps/email-worker && $W deploy --message "cmail $SHA (retry)" >/tmp/cmail-$INST-worker.out 2>&1); } \
  || { tail -5 /tmp/cmail-$INST-worker.out; die "worker deploy failed; live is $(latest)"; }
newWorker=$(latest); [ "$newWorker" != "$prevWorker" ] || die "worker version did not change"
log "worker live $newWorker"
smoke || { rollback_worker; die "smoke failed after worker deploy"; }
(cd apps/web && pnpm build >/tmp/cmail-$INST-build.out 2>&1) || { rollback_worker; die "web build failed"; }
(cd apps/web && $W pages deploy .svelte-kit/cloudflare --project-name "$PROJ" --branch main --commit-hash "$(git rev-parse HEAD)" --commit-message "cmail $SHA" >/tmp/cmail-$INST-pages.out 2>&1) \
  || { tail -5 /tmp/cmail-$INST-pages.out; rollback_worker; die "pages deploy failed; pages stays $prevPages"; }
sleep 8
newPages=$($W pages deployment list --project-name "$PROJ" --environment production --json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['Id'])")
if ! smoke || [ "$newPages" = "$prevPages" ]; then
  log "SMOKE FAIL after pages; rolling Pages back to $prevPages, then the worker"
  # The token goes in on stdin (-K -), not on the command line where ps could show it.
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" | curl -s -K - -X POST \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PROJ/deployments/$prevPages/rollback" \
    | python3 -c "import sys,json;print('pages rollback success:',json.load(sys.stdin).get('success'))" | tee -a "$LOG"
  rollback_worker; die "pages smoke failed"
fi
log "OK $SHA: worker $newWorker (rollback $prevWorker), pages $newPages (rollback $prevPages)"
