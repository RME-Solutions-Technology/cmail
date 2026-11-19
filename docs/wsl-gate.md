# Local gate and deploys in WSL

GitHub Actions is not needed to merge or deploy. The same checks run on a maintainer's machine in WSL (Ubuntu), and deploys run from there too.

## One-time setup

```bash
bash scripts/wsl/setup.sh
```

Installs fnm with Node 22, 24 and 26, the pnpm version pinned in `package.json`, PowerShell 7.6.10 (for the collector harness) and the packages Playwright needs. It changes nothing on the Windows side.

## Run the gate before merging

```bash
bash scripts/wsl/test.sh <branch-or-sha>            # everything
bash scripts/wsl/test.sh <branch-or-sha> --only validate --nodes "24"
```

It works in a fresh copy under `~/cmail-gate` and runs:

| Check | Same as workflow | Runs here |
|---|---|---|
| `pnpm release:check` on Node 22, 24, 26 | CI "Validate on Node" | yes |
| collector harness and onboarding scripts (PowerShell) | CI "collector-harness" | yes |
| axe, smoke, phone performance budgets, Focused Inbox | E2E "axe + smoke" | yes |
| CodeQL | CodeQL | **no**: GitHub's hosted analysis only. It stays a GitHub check. |

Take your machine's heavy-job lock first if you share the machine; builds and Playwright are heavy.

## Deploy

```bash
CMAIL_INSTANCES_FILE=/path/to/instances.sh bash scripts/wsl/deploy.sh <instance> <sha> "<review line>"
```

`instances.sh` is private (not in git) and sets `ACCT[<i>]`, `HOST[<i>]` and `CLONE[<i>]`, the folder holding that instance's untracked `wrangler.toml` files. `CLOUDFLARE_API_TOKEN` comes from the environment. The script stops if D1 migrations are pending, records the rollback ids, deploys the email worker then Pages, smoke-tests, and rolls back by itself if a smoke test fails. It never runs migrations.
