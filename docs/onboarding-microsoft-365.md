---
title: "Onboarding an organisation that uses Microsoft 365"
summary: "The tested order from an empty instance to staff signing in with Microsoft, then the optional standby steps."
applies_to: standby
audience: [operator, client admin]
switch: none
last_reviewed: 2026-11-16
related: [credentials.md, m365-sync.md, exchange-mirror.md, standby-switch.md]
---

# Onboarding an organisation that uses Microsoft 365

This guide takes a new cmail instance from nothing to "staff sign in with
their Microsoft account", for an organisation whose mail stays in Exchange
Online. Optional steps then make cmail a warm standby: a standby subdomain,
the Exchange mirror, shared mailbox permissions, and the standby switch.

It is the order that worked in the first production onboarding of a
Microsoft 365 tenant. Each step says why it is there, what to run (a script
from [`scripts/onboarding/`](../scripts/onboarding/README.md) and the manual
equivalent), how to check it, how to undo it, and what tripped us up.

**Status.** The steps and their order are proven once, on one tenant, with
Exchange Online staying primary and its MX untouched. The scripts are
parameterised versions of the ones used there; in this form they are
tested only against mocks (`scripts/onboarding/onboarding.Tests.ps1`), not
yet against a tenant. Run each with `-WhatIf` first. The feature docs linked
from each step stay the reference for settings and behaviour.

Every step that changes a live system (DNS, Entra, Exchange, a remote
database) needs the owner's yes under your own change process.

**In this article**

- [Checklist](#checklist)
- [0. What you need first](#0-what-you-need-first)
- [1. Instance](#1-instance)
- [2. Domain for the web app](#2-domain-for-the-web-app)
- [3. Sign-in app](#3-sign-in-app)
- [4. Bootstrap the first manager](#4-bootstrap-the-first-manager)
- [5. Microsoft 365 sync](#5-microsoft-365-sync)
- [6. Staff sign-in](#6-staff-sign-in)
- [7. Passkeys](#7-passkeys)
- [8. Welcome emails (optional)](#8-welcome-emails-optional)
- [9. Standby subdomain (optional)](#9-standby-subdomain-optional)
- [10. Exchange mirror (optional)](#10-exchange-mirror-optional)
- [11. Shared mailbox permissions (optional)](#11-shared-mailbox-permissions-optional)
- [12. Standby test, switch and copy-back (optional)](#12-standby-test-switch-and-copy-back-optional)
- [Lessons from the first onboarding](#lessons-from-the-first-onboarding)

## Checklist

Placeholders: `example.com` is the organisation's mail domain,
`https://mail.example.com` the web app, `cmail-web` the Pages project,
`apps/email-worker/wrangler.toml` the instance's own Worker config.

| # | Step | Done when |
|---|---|---|
| 0 | Accounts, tools, decisions | Cloudflare account, Entra admin, `az` + `pnpm` + PowerShell 7 ready; names chosen |
| 1 | Instance: D1, R2, Worker, Pages, migrations | Empty database migrated; Worker and Pages deployed; `*.pages.dev` answers |
| 2 | Custom domain `mail.example.com` | `https://mail.example.com` answers 200 over HTTPS |
| 3 | Sign-in app (`new-signin-app.ps1`) | "Sign in with Microsoft" shows on the sign-in page |
| 4 | Bootstrap (`set-bootstrap-secrets.ps1`, then `-Remove`) | One active manager; `/bootstrap` redirects |
| 5 | Microsoft 365 sync (`new-sync-app.ps1`) | Dry run report reads right; dry run off; counts match Microsoft 365 |
| 6 | Staff sign-in | A synced person signs in with Microsoft, no invitation |
| 7 | Passkeys | A person signs in at `/auth/passkey` |
| 8 | Welcome emails (optional) | One test account got its email |
| 9 | Standby subdomain (optional) | `standby.example.com` has Cloudflare MX; apex MX unchanged |
| 10 | Exchange mirror (optional, `exchange-mirror.ps1`) | Admin shows reports "filed", none refused |
| 11 | Shared mailbox permissions (optional, `perms-setup.ps1`) | Go/no-go is GO; dry run report matches Exchange |
| 12 | Standby test, switch, copy-back (optional) | Each feature's own drill done |

## 0. What you need first

**Purpose.** Everything later assumes these are in place; missing one is the
usual reason a step stalls halfway.

- **Cloudflare:** an account on Workers Paid (Containers in step 11 need
  it), the organisation's DNS zone on Cloudflare (needed for step 2 by CNAME
  and for steps 9 to 12), and Wrangler signed in (`pnpm exec wrangler whoami`).
  If you work with several accounts, set `CLOUDFLARE_ACCOUNT_ID` in the
  session before every Wrangler command.
- **Microsoft 365 roles, active:** Application Administrator (or Cloud
  Application Administrator) to create apps (step 3); **Global
  Administrator** for admin consent, as the
  [az ad app permission admin-consent](https://learn.microsoft.com/en-us/cli/azure/ad/app/permission#az-ad-app-permission-admin-consent)
  documentation requires (steps 5 and 11; also step 3 with
  `-GrantAdminConsent`); Exchange Administrator (or Global Administrator)
  for steps 10 and 11. The scripts also accept Privileged Role Administrator
  plus Application Administrator for steps 5 and 11; that combination is
  not verified, so use Global Administrator where you can. The scripts check
  roles first and stop before creating anything. Note the **tenant ID** (Entra admin center >
  Overview) and the **initial domain** (`<name>.onmicrosoft.com`).
- **Tools:** Node and pnpm with `pnpm install` done in this repository;
  PowerShell 7.2+ (`pwsh`); Azure CLI signed in to the tenant with
  `az login --tenant <tenant id> --allow-no-subscriptions`; the
  ExchangeOnlineManagement module for steps 10 and 11; Docker for step 11.
  Step 11's certificate step needs Windows.
- **Decisions:** the web address (`mail.example.com`), resource names (D1,
  R2, Worker, Pages project), the first manager's address, and whether you
  will do the optional standby steps (they need a subdomain such as
  `standby.example.com`).
- **A secrets register** (where each secret lives and when it expires) and
  a private folder outside git for the instance's `wrangler.toml` files and
  the journal address.

**Pitfalls.**
- **PIM.** If the admin roles are eligible in Privileged Identity Management,
  activate them (Entra > Privileged Identity Management > My roles) before
  each session, wait a minute, then run `az login` again: `az` keeps the
  roles it had when it signed in, so a role activated afterwards is not
  seen. Reconnect Exchange Online after activating too. Activations expire
  (often after a few hours), so a long onboarding may need them again.
- Do every Cloudflare step in the instance's own account. Never copy a
  resource ID, Worker name or bucket between accounts
  ([deployment.md](deployment.md#2-provision-cloudflare-resources)).
- Pass `--env=""` to every Wrangler `secret put`, `secret delete` and
  `d1 execute` on an instance whose `wrangler.toml` has an `[env.preview]`
  section, so the command targets the production (top-level) environment
  without ambiguity. The scripts always do.

## 1. Instance

**Purpose.** Create the storage and deploy both apps before any sign-in
exists, so you test each layer on its own.

**Run.** Follow [Deployment and verification](deployment.md) sections 1 to
3: create D1 and R2 (`pnpm d1:create`, `pnpm r2:create`), fill in the
instance's `apps/web/wrangler.toml` and `apps/email-worker/wrangler.toml`
(set `APP_NAME`, `MAIL_DOMAIN = "example.com"` and, for now,
`APP_URL = "https://<project>.pages.dev"`), set `SESSION_SECRET` and the
required inbound Worker secret, then:

```sh
# Is the database empty? Both must be 0 for a new instance.
pnpm exec wrangler d1 execute <db name> --remote --config apps/web/wrangler.toml --env="" --command "SELECT count(*) AS c FROM users"
pnpm exec wrangler d1 execute <db name> --remote --config apps/web/wrangler.toml --env="" --command "SELECT count(*) AS c FROM messages"
pnpm db:migrate              # applies every migration in packages/shared/migrations
pnpm deploy:email-worker     # the Worker first: Pages binds to it
pnpm deploy:web
```

**Check.** `pnpm exec wrangler d1 migrations list DB --remote --config apps/web/wrangler.toml`
says there is nothing to apply. `https://<project>.pages.dev/` answers 200
and shows no sign-in buttons yet (that is correct: no provider is configured).

**Undo.** Nothing holds mail yet: delete the Pages project, Worker, D1 and
R2 in the dashboard if you need to start again.

**Pitfalls.**
- Check the database really is empty before the first migration. A
  non-empty database means you are pointing at the wrong one: stop.
- On a database that already holds data, take a D1 Time Travel bookmark
  first (`wrangler d1 time-travel info <db name>`) and compare row counts
  before and after. For additive migrations the bookmark is enough; no
  export is needed
  ([D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)).

## 2. Domain for the web app

**Purpose.** Sign-in callbacks and passkeys are bound to the final web
address, so it must be fixed before step 3.

**Run (dashboard).** Workers & Pages > the Pages project > Custom domains >
Set up a domain > `mail.example.com`. Then, in the zone's DNS, add a
proxied CNAME `mail` -> `<project>.pages.dev` (if the dashboard did not add
it for you). Add the custom domain in Pages **first**: a CNAME without it
returns errors
([Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)).

Then set `APP_URL = "https://mail.example.com"` in `apps/web/wrangler.toml`
and redeploy the web app (`pnpm deploy:web`).

**Check.** `curl -sI https://mail.example.com/` answers 200 with a valid
certificate.

**Undo.** Remove the custom domain in Pages and the `mail` CNAME.

**Pitfalls.**
- Look first for an existing `mail` record (an old webmail or autodiscover
  entry). Do not overwrite something in use; pick another name.
- The Pages domain status can stay "pending" for several minutes after the
  site already answers 200. Trust the HTTPS check.
- Changing `APP_URL` later breaks every passkey and needs a new redirect URI.

## 3. Sign-in app

**Purpose.** Staff sign in with their Microsoft 365 account. This app only
signs people in: delegated `openid email profile`, single tenant, nothing
else. The sync (step 5) has its own app.

**Script.**

```powershell
pwsh -File scripts/onboarding/new-signin-app.ps1 -TenantId <tenant id> `
  -AppUrl https://mail.example.com -PagesProject cmail-web -WhatIf
# then without -WhatIf; add -GrantAdminConsent if users may not consent to apps
```

It creates (or reuses by name) the app with the Web redirect URI
`https://mail.example.com/auth/callback/microsoft`, stores
`MICROSOFT_CLIENT_ID` and pipes a new client secret from
`az ad app credential reset` into `wrangler pages secret put MICROSOFT_CLIENT_SECRET`
([az ad app credential reset](https://learn.microsoft.com/en-us/cli/azure/ad/app/credential#az-ad-app-credential-reset)).
The secret is never shown.

**Manual equivalent.** Entra admin center > App registrations > New
registration: single tenant; redirect URI platform **Web**,
`https://mail.example.com/auth/callback/microsoft`. API permissions: Microsoft
Graph delegated `openid`, `email`, `profile` only. Certificates & secrets >
New client secret; then `pnpm exec wrangler pages secret put MICROSOFT_CLIENT_ID --project-name cmail-web --env=""`
and the same for `MICROSOFT_CLIENT_SECRET`, pasting at the prompt.

Then, either way: `MICROSOFT_TENANT_ID = "<tenant id>"` in
`apps/web/wrangler.toml` `[vars]`, and `pnpm deploy:web` (Pages secrets take
effect on the next deployment).

**Check.** The sign-in page shows "Sign in with Microsoft". It does nothing
useful until step 4: nobody has an account yet.

**Undo.** `az ad app delete --id <app id>`;
`pnpm exec wrangler pages secret delete MICROSOFT_CLIENT_SECRET --project-name cmail-web --env=""`
(and `MICROSOFT_CLIENT_ID`); redeploy.

**Pitfalls.**
- Use the tenant GUID for `MICROSOFT_TENANT_ID`, not `common`: synced staff
  sign in without invitations (step 6) only when the web app knows the tenant
  (this, or `M365_TENANT_ID` on the web app).
- `MICROSOFT_CLIENT_ID` is not secret; the client secret is. Only the admin
  who creates it should handle it, and only by piping or pasting at a prompt.
- The scripts stop if `az` is signed in to a different tenant. Check
  `az account show` when you work with several tenants.
- Record the secret's expiry date and rotate before it.

Reference: [Configuration: OAuth](configuration.md#oauth),
[Deployment step 4](deployment.md#4-configure-identity-providers-and-secrets).

## 4. Bootstrap the first manager

**Purpose.** The first manager is the only account created without an
invitation. Bootstrap is on only while two temporary secrets exist.

**Script.**

```powershell
pwsh -File scripts/onboarding/set-bootstrap-secrets.ps1 -PagesProject cmail-web -AdminEmail admin@example.com
pnpm deploy:web
# open https://mail.example.com/bootstrap, paste the token (it is on your clipboard),
# sign in with Microsoft as admin@example.com
pwsh -File scripts/onboarding/set-bootstrap-secrets.ps1 -PagesProject cmail-web -Remove
pnpm deploy:web
```

The token is 32 random bytes, copied to the clipboard and not shown
(`-TokenOutput Console` shows it once instead).

**Manual equivalent.** [Deployment step 9](deployment.md#9-bootstrap-and-lock-down-administration).

**Check.**

```sh
pnpm exec wrangler d1 execute <db name> --remote --config apps/web/wrangler.toml --env="" --command "SELECT role, status, count(*) AS n FROM users GROUP BY role, status"
```

shows exactly one active manager. After `-Remove` and the redeploy,
`/bootstrap` redirects away.

**Undo.** If bootstrap failed or the token may have leaked, run `-Remove`,
redeploy, and start again with a new token.

**Pitfalls.**
- Type the token into the form; never put it in a URL, chat or ticket.
- The admin address must match the Microsoft account's email exactly.
- The proof cookie lasts 10 minutes: sign in straight after submitting.
- Delete both secrets as soon as it works.

## 5. Microsoft 365 sync

**Purpose.** cmail creates an account and mailbox for each licensed person
on the mail domain, pauses leavers, and (optionally) finds shared mailboxes.
It reads Microsoft 365 and never writes to it.

**Script.**

```powershell
pwsh -File scripts/onboarding/new-sync-app.ps1 -TenantId <tenant id> -MailDomain example.com `
  -WranglerConfig apps/email-worker/wrangler.toml -DetectSharedMailboxes -WhatIf
# then without -WhatIf
```

It creates a separate app with Graph **application** permissions
`User.Read.All` (plus `MailboxSettings.Read` with `-DetectSharedMailboxes`,
`GroupMember.Read.All` with `-GroupScoped`), tries admin consent with
`az ad app permission admin-consent`
([reference](https://learn.microsoft.com/en-us/cli/azure/ad/app/permission#az-ad-app-permission-admin-consent)),
reads the grants back from the service principal's `appRoleAssignments`,
grants any that are still missing directly
([grant an appRoleAssignment](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignedto)),
and pipes a new client secret into the Worker secret `M365_CLIENT_SECRET`.

**Manual equivalent.** [Microsoft 365 sync: Entra app setup](m365-sync.md#how-to-set-up-the-entra-app-least-privilege).

Then, either way, in `apps/email-worker/wrangler.toml` `[vars]`:
`M365_TENANT_ID`, `M365_CLIENT_ID`, `MAIL_DOMAIN`,
`M365_DETECT_SHARED_MAILBOXES = "true"` if wanted; keep the `*/15 * * * *`
cron; `pnpm deploy:email-worker`. Then Admin > Microsoft 365 sync: turn it
on with **dry run on**, press **Sync now**, and read the report.

**Check.** The dry run counts match Microsoft 365 (people, shared mailboxes,
conflicts). Fix conflicts at the source, then turn **dry run off**. The first
live round runs on the next 15-minute tick and always reconciles after a dry
run. Admin then shows result `ok`; Admin > People lists the synced people.

**Undo.** Turn the sync off (accounts stay as they are). To remove it:
`wrangler secret delete M365_CLIENT_SECRET --config apps/email-worker/wrangler.toml --env=""`,
remove the vars, `az ad app delete --id <app id>`.

**Pitfalls.**
- `az ad app permission admin-consent` can return success without applying
  an application permission: on the first live tenant it did not apply
  `Exchange.ManageAsApp`, and a direct appRoleAssignment did. Always check
  Entra > Enterprise applications > the app > Permissions (or the service
  principal's `appRoleAssignments`). The scripts check and fall back to the
  direct grant.
- "Type unknown" for every mailbox means `MailboxSettings.Read` is missing or
  not consented.
- A large first change is held by the mass-pause brake; read it, then approve
  or fix the cause ([runbook](m365-sync.md#runbook)).

## 6. Staff sign-in

**Purpose.** Synced people sign in with **Sign in with Microsoft** on cmail's
own page, with no invitation.

**Run.** Nothing extra: it works once steps 3 and 5 are done and the web
app knows the tenant (`MICROSOFT_TENANT_ID` set to the tenant GUID, or
`M365_TENANT_ID` on the web app). cmail binds the person by the ID token's
`oid` and `tid`, never by email or UPN
([how it works](m365-sync.md#first-sign-in)).

**Check.** A synced, non-manager test person signs in and lands in their
mailbox. The audit log shows `auth.sync_link_bound`. A refused sign-in shows
its reason on `auth.sign_in_denied`.

**Undo.** Turning the sync off stops new binds; existing binds keep working
like any sign-in.

**Pitfalls.** Guests and managers never bind this way (managers come from
bootstrap or invitations). If you put Cloudflare Access in front of the site,
read [staff sign-in](staff-sign-in.md) first.

## 7. Passkeys

**Purpose.** A sign-in that keeps working when Microsoft or Cloudflare Access
is down.

**Run.** Admin > **Passkey sign-in** > turn on. Each person signs in with
Microsoft (a fresh sign-in), then Mail > Settings > Passkeys > add one, and
bookmarks `https://mail.example.com/auth/passkey`.

**Check.** Sign out, open `/auth/passkey`, sign in with the passkey.

**Undo.** Turn passkey sign-in off: every passkey session ends; registered
passkeys are kept.

**Pitfalls.** Passkeys are bound to the `APP_URL` host. Behind Cloudflare
Access, `/auth/passkey` needs its own Bypass application. Details:
[Passkey break-glass sign-in](passkeys.md#how-to-set-up-passkeys).

## 8. Welcome emails (optional)

**Purpose.** Email each person the sync creates once, with first sign-in
steps.

**Run.** Needs working outbound mail from `MAIL_DOMAIN` and step 6. Admin >
Microsoft 365 sync > Welcome emails, with the sync in dry run first; send to
one test account before anyone else. Full steps:
[Microsoft 365 welcome emails: runbook](m365-welcome-emails.md#runbook).

**Check.** The test account's Inbox in Exchange has the email; Exchange
message trace shows it delivered.

**Undo.** Turn the switch off: unsent emails are cancelled.

## 9. Standby subdomain (optional)

**Purpose.** Give cmail its own way to receive mail while the domain's MX
stays with Exchange Online. Steps 10 and 12 build on it.

**Run (dashboard).** Email Service > Email Routing > the apex domain >
Settings > **Subdomains** > add `standby` (giving `standby.example.com`)
([Email Routing subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/)).

**Do not:**
- click **Add missing records** for the apex: it adds Cloudflare MX at the
  apex next to Exchange's, which splits delivery;
- click the red **Delete** buttons beside the Exchange MX and SPF records
  marked "Conflicting";
- use the zone-level **Disable** of Email Routing.

**Check.**

```sh
dig +short MX example.com            # still only Exchange Online
dig +short MX standby.example.com    # Cloudflare (route*.mx.cloudflare.net)
dig +short TXT standby.example.com   # v=spf1 ... include:_spf.mx.cloudflare.net ...
```

On Windows without `dig`:

```powershell
Resolve-DnsName example.com -Type MX
Resolve-DnsName standby.example.com -Type MX
Resolve-DnsName standby.example.com -Type TXT
```

Expected: the apex MX and SPF are untouched; the subdomain has Cloudflare MX
and SPF; Cloudflare also publishes its own DKIM selector record at the apex
(harmless). Email Routing shows "Enabled" with "DNS records misconfigured"
for the apex: that is expected while the apex MX stays with Exchange.

**Undo.** Remove the subdomain under Email Routing > Settings > Subdomains;
check the apex records are unchanged.

**Pitfalls.**
- Catch-all rules exist only on the apex. The subdomain needs one literal
  rule per address (200 rules per domain).
- The subdomain's MX records are locked by Email Routing; its SPF TXT record
  is editable (step 10 needs that).

## 10. Exchange mirror (optional)

**Purpose.** cmail keeps a live copy of the tenant's mail from one Exchange
journal rule, so a standby has recent mail. Read
[Exchange mirror](exchange-mirror.md) first, including how a report is
trusted and the privacy section.

**Script (three runs, each after the step before is checked).** It needs
an active Exchange Administrator (or Global Administrator) role; after
connecting it checks the journaling cmdlets are available and stops before
any change if not. Every Exchange call stops on error.

```powershell
$m = @{ StandbySubdomain = 'standby.example.com'; JournalAddressFile = '<private folder>/journal-address.txt' }
# a. New journal address -> Worker secret M365_JOURNAL_ADDRESS, then the file (only once the secret is stored)
pwsh -File scripts/onboarding/exchange-mirror.ps1 @m -NewJournalAddress -WranglerConfig apps/email-worker/wrangler.toml
# b. Exchange: NDR address (previous value saved), TNEF-off remote domain, journal rule DISABLED
pwsh -File scripts/onboarding/exchange-mirror.ps1 @m -NdrAddress journal-ndr@standby.example.com -WhatIf
pwsh -File scripts/onboarding/exchange-mirror.ps1 @m -NdrAddress journal-ndr@standby.example.com
# c. After the mirror is on in Admin: enable the rule
pwsh -File scripts/onboarding/exchange-mirror.ps1 @m -Enable
```

Between a and b:
1. Worker `[vars]`: `M365_TENANT_ID`, `M365_JOURNAL_NDR_DOMAIN = "standby.example.com"`,
   `INBOUND_AUTHSERV_ID = "mx.cloudflare.net"` and the rest of
   [Exchange mirror setup](exchange-mirror.md#1-cmail); migration `0027`;
   deploy the Worker, then the web app.
2. Email Routing on `standby.example.com`: one rule for the literal journal
   address (from the file) -> **Send to a Worker** -> the cmail email Worker.
   A second rule for the NDR address to a mailbox a person reads (a cmail
   mailbox through its standby address, or "Send to an email" to a verified
   address outside Exchange Online).
3. Add `include:spf.protection.outlook.com` to the SPF TXT record of
   `standby.example.com`, keeping the Cloudflare include.

Between b and c: Admin > Exchange mirror > **Turn on**.

**Manual equivalent.** [Exchange mirror: Exchange Online](exchange-mirror.md#3-exchange-online)
(`Set-TransportConfig -JournalingReportNdrTo`, `New-RemoteDomain` +
`Set-RemoteDomain -TNEFEnabled $false`, `New-JournalRule -Scope Global -Enabled $false`,
then `Enable-JournalRule`). Save `(Get-TransportConfig).JournalingReportNdrTo`
before changing it.

**Check.** Send a message between two licensed users. Within a minute Admin >
Exchange mirror shows a last report time, the message "filed", and no
refused reports. If reports are refused, read the reason and the safe
diagnostic in the audit log ([diagnosing](exchange-mirror.md#troubleshoot-refused-reports)).

**Undo.** `exchange-mirror.ps1 @m -Rollback`: disables and removes the
rule, removes the remote domain and restores the saved NDR address. Then
Admin > Exchange mirror > Turn off; optionally delete the routing rule and
`M365_JOURNAL_ADDRESS`. Mirrored mail stays until a manager removes it.

**Pitfalls (all seen live).**
- A journal report carries the **original sender** in From and the NDR
  address as envelope MAIL FROM. So DMARC on From can never prove the
  tenant. The outer report had no DKIM signature and usually no
  `X-MS-Exchange-CrossTenant-Id`. What authenticates it is SPF for the NDR
  domain, which passes only once `include:spf.protection.outlook.com` is in
  that domain's SPF.
- Cloudflare's `Authentication-Results` carries a bare `spf=pass` before the
  `spf=pass smtp.mailfrom=<NDR domain>` result. cmail before PR 123 read the
  first one, so every report failed `auth_failed`; run a cmail version that
  includes that fix (it uses the SPF result that names `smtp.mailfrom`).
- Without that SPF include, and with `M365_JOURNAL_REQUIRE_AUTH = "true"`,
  every report is refused, Exchange sends one NDR per report to the NDR
  address, and refused reports risk Exchange disabling the rule after two
  days. Fix SPF before `-Enable` (the script checks it where `Resolve-DnsName`
  exists).
- Journaling copies **all** mail from the moment the rule is enabled; the
  mirror holds only mail from then on, nothing older.
- The secret journal address is the real security boundary. Keep the file
  private; rotate it if it leaks ([rotating](exchange-mirror.md#how-to-rotate-the-journal-token)).
- The NDR address must be outside Exchange Online (Microsoft's rule).
- Not verified: whether Exchange Online accepts clearing
  `JournalingReportNdrTo` to empty on rollback when it was empty before. If
  it refuses, set it to another mailbox outside Exchange Online.

## 11. Shared mailbox permissions (optional)

**Purpose.** Copy who has Full Access and Send As on shared mailboxes from
Exchange into cmail daily. Graph cannot read these permissions, and the
Exchange Online Admin API (preview) does not cover them, so cmail runs the
Exchange PowerShell module in a Cloudflare Container, read-only. Read
[Shared mailbox access from Exchange Online](m365-mailbox-permissions.md) first.

**Script.**

```powershell
pwsh -File scripts/onboarding/perms-setup.ps1 -TenantId <tenant id> -Organization <name>.onmicrosoft.com `
  -WranglerConfig apps/email-worker/wrangler.toml -WhatIf
# then without -WhatIf, on Windows, as an admin who can consent and manage Exchange roles
```

After the role pre-flight it creates a third app with the Office 365
Exchange Online application permission `Exchange.ManageAsApp` (admin consent,
checked, with the direct grant as fallback); a self-signed certificate with a
CSP key, the public part on the app (a rerun reuses a valid certificate that
is already on the app instead of adding another); a custom role from
"Mail Recipients" trimmed to six read cmdlets (`Get-Mailbox`,
`Get-MailboxPermission`, `Get-RecipientPermission`, `Get-Recipient`,
`Get-User`, `Get-Group`) in its own role group; the app's Exchange service
principal in that group. Then, **as the app**, the go/no-go: no write
cmdlet (`Add-`/`Remove-MailboxPermission`, `Add-`/`Remove-RecipientPermission`,
`Set-Mailbox`) may be available to the app's session (nothing is attempted),
and a shared mailbox's grants must be readable; any unexpected error is a
no-go. Only on GO does it pipe
the PFX (base64) and its random password into the Worker secrets
`M365_EXO_CERT_PFX_B64` and `M365_EXO_CERT_PASSWORD`, and delete the PFX file
([app-only auth for Exchange Online PowerShell](https://learn.microsoft.com/en-us/powershell/exchange/app-only-auth-powershell-v2)).

**Manual equivalent.** [Setup steps 1 to 5](m365-mailbox-permissions.md#how-to-set-up-shared-mailbox-access).

Then: `[vars]` `M365_EXO_APP_ID` and `M365_EXO_ORGANIZATION`; uncomment the
container block from `wrangler.toml.example`; migration `0028`; with Docker
running, deploy the Worker, then the web app; Admin > Shared mailbox access >
Turn on (dry run stays on).

**Check.** Two cron runs later the report matches Exchange for a shared
mailbox where you know who has Full Access. Run the collector check in
[step 4 of the feature doc](m365-mailbox-permissions.md#4-go--no-go-run-the-real-collector-from-your-own-pc)
before turning dry run off.

**Undo.** Admin > Turn off. `perms-setup.ps1 ... -Rollback` removes the role
group, role, Exchange service principal, Entra app and the local
certificate. Comment the container block out and redeploy to remove the
container. Grants already written stay (see the feature doc's rollback).

**Pitfalls.**
- No-go if the app can write: the script stores nothing; run `-Rollback`
  and check the role.
- The certificate's private key stays in your Windows certificate store
  (CurrentUser\My) so a rerun or renewal can reuse it. Pass
  `-RemoveLocalCertificate` to delete it once the Worker secret is stored;
  the secret is then the only copy, and a rerun makes a new certificate.
- The go/no-go needs at least one shared mailbox in the tenant.
- Exchange role changes take a minute or more to apply; the script waits 60
  seconds before checking.
- The certificate expires (12 months by default): put the date in the
  secrets register.
- Deploying the Worker builds the container image: Docker must be running.

## 12. Standby test, switch and copy-back (optional)

These are drills, each with its own runbook. Do them in a planned window,
after steps 9 and 10.

- [Standby test address and daily probe](standby-probe.md): every mailbox
  also answers at `name@standby.example.com` (one routing rule per address),
  with a daily probe.
- [Switch mail to the cmail standby, and back](standby-switch.md): move the
  domain's MX to Cloudflare in one DNS change, and back. Dry run first.
- [Copy standby mail back into Exchange](copy-back.md): after an outage,
  copy what cmail received into each person's Exchange mailbox.

## Lessons from the first onboarding

Beyond the pitfalls above, these cost time and are worth knowing:

- **`fetch` in Workers.** Never call `fetch` as a method of an object
  (`this.fetcher(...)` with `fetch` stored on the object): the runtime
  throws "Illegal invocation", which surfaced as a generic network error.
  Call it as a plain function or bind it.
- **Email Obfuscation and CSP.** If Cloudflare Email Obfuscation is on for a
  site with a Content Security Policy, the policy needs `script-src 'self'`
  (the decoder script is served from the site's own `/cdn-cgi/` path), or
  every `mailto:` link opens Cloudflare's block page.
- **Additive migrations.** A D1 Time Travel bookmark is enough rollback; no
  export needed. Always compare row counts before and after.
- **Secrets by pipe.** Every secret went from the tool that made it straight
  into Wrangler on stdin. Nothing secret was typed into chat, a ticket or a
  command line, which is what the scripts here keep doing.
