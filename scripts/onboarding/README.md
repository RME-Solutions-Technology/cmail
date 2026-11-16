# Onboarding scripts (Microsoft 365)

PowerShell 7 scripts for the tenant and secret steps of
[Onboarding an organisation that uses Microsoft 365](../../docs/onboarding-microsoft-365.md).
Read the guide first: it says when to run each one, how to check it worked
and how to undo it. Each script also has full help:
`pwsh -File scripts/onboarding/<script>.ps1 -?` (or `Get-Help <path> -Full`).

| Script | Guide step | What it changes |
|---|---|---|
| `new-signin-app.ps1` | 3. Sign-in app | Entra app for staff sign-in (single tenant, `openid email profile`); Pages secrets `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` |
| `set-bootstrap-secrets.ps1` | 4. Bootstrap | Pages secrets `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_TOKEN`; `-Remove` deletes both |
| `new-sync-app.ps1` | 5. Microsoft 365 sync | Read-only Graph app (`User.Read.All`, optional `MailboxSettings.Read`, `GroupMember.Read.All`), admin consent; Worker secret `M365_CLIENT_SECRET` |
| `exchange-mirror.ps1` | 10. Exchange mirror | `-NewJournalAddress`: Worker secret `M365_JOURNAL_ADDRESS`. Then Exchange: undeliverable-report address, TNEF-off remote domain, journal rule (disabled); `-Enable`; `-Rollback` |
| `perms-setup.ps1` | 11. Shared mailbox permissions | App with `Exchange.ManageAsApp`, certificate, read-only Exchange role and role group, go/no-go; Worker secrets `M365_EXO_CERT_PFX_B64`, `M365_EXO_CERT_PASSWORD`; `-Rollback` |

## Rules they keep

- **Parameters only.** Nothing about a tenant, domain or Cloudflare account is
  in the scripts. Pass `-TenantId`, `-AppUrl`, `-PagesProject`,
  `-WranglerConfig`, `-MailDomain`, `-StandbySubdomain`, `-Organization` and
  so on.
- **Secrets never show.** A client secret, token, journal address or
  certificate is held in a variable and piped to `wrangler ... secret put` on
  stdin. It is never printed, never a command-line argument and never left in
  a file. The one exception you choose: `set-bootstrap-secrets.ps1
  -TokenOutput Console` shows the one-time bootstrap token once (the default
  copies it to the clipboard).
- **Dry run first.** Every script takes `-WhatIf`: it signs in to nothing and
  lists what it would change. `-Confirm` asks before each change.
- **Stop on the first error.** A failed `az`, `wrangler` or Exchange command
  stops the script; a check that fails (wrong `az` tenant, no-go, missing
  role entry) stops it before anything is stored.
- **Reruns are safe.** Existing apps, roles, rules and saved values are reused
  rather than duplicated. A rerun of a secret step adds a new secret; delete
  old ones in Entra once the new one works.

## Before you run them

- PowerShell 7.2 or later (`pwsh`). `perms-setup.ps1` needs Windows for the
  certificate step (`New-SelfSignedCertificate` with a CSP key).
- Azure CLI signed in to the customer tenant:
  `az login --tenant <tenant id> --allow-no-subscriptions`. The scripts stop
  if `az` is signed in to another tenant.
- In this repository: `pnpm install` done, and Wrangler signed in to the
  Cloudflare account that holds the instance (`pnpm exec wrangler whoami`).
  For an account other than your default, set `CLOUDFLARE_ACCOUNT_ID` in the
  session first.
- For the Exchange scripts: `Install-Module ExchangeOnlineManagement -Scope CurrentUser`
  (`perms-setup.ps1` loads 3.11.1, the version the collector image pins; pass
  `-ExchangeModuleVersion` to use another).
- `-WranglerConfig` is the instance's own `apps/email-worker/wrangler.toml`
  (ignored by git), not the `.example`.

## Tests

`pwsh -NoProfile -File scripts/onboarding/onboarding.Tests.ps1` runs every
script against recording stand-ins for `az`, `pnpm` and the Exchange cmdlets
(no tenant, no network). It checks help, ASCII and placeholder-only
identifiers, that `-WhatIf` calls nothing, that secrets reach Wrangler's
stdin and no output stream, the mirror's save-and-restore of the previous
undeliverable-report address, and that the permission setup stores nothing
on a no-go. It runs PSScriptAnalyzer too when that module is installed. CI
runs it in the PowerShell job.
