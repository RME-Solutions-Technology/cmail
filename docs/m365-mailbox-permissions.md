# Shared mailbox access from Exchange Online

Copies **Full Access** and **Send As** on Exchange Online shared mailboxes into
cmail's shared mailbox assignments, automatically, once a day.

**Status: built, off by default, not yet tested against a real tenant or a
deployed Cloudflare Container.** Everything below that says "unverified" must
be checked in a test tenant (never a client's) before the first live use.

It is an optional add-on to the [Microsoft 365 mailbox sync](m365-sync.md):
that sync creates the cmail accounts and shared mailboxes; this feature then
gives people access to those shared mailboxes the way Exchange does.

## In short

- **Off by default.** A manager switch in Admin > Shared mailbox access. While
  off, the scheduled job reads one setting and returns: no container start, no
  Microsoft call, no write. Primary mail (receiving, sending, personal
  mailboxes, the Microsoft 365 sync) is not touched either way. A test proves
  the whole database is byte-for-byte unchanged while the switch is off.
- **Dry run first.** Turning it on starts in dry run: each run reports what
  it would change and writes nothing but its own status.
- **Read-only toward Microsoft.** A small PowerShell collector in a Cloudflare
  Container signs in to Exchange Online app-only with a certificate and runs
  four `Get-` cmdlets. Write cmdlets are refused by the script itself and
  should also be impossible through the Exchange role it is given.
- **Only its own rows.** The sync raises, lowers or removes only assignments it
  made itself and that nobody changed since. Anything a manager set in
  Admin > Mailboxes (or Organisation) is never changed or removed.
- **Failure never removes access.** If the collector fails, times out, or
  returns partial, empty or invalid data, current assignments stay exactly as
  they are and the next run tries again. After 3 failed runs in a row Admin
  shows an alert. Mail delivery is never involved.
- **Brake on mass removal.** A run that would remove or lower too much access
  applies its additions but holds removals until a manager approves them.
- **Daily**, plus a **Sync access now** button. Shared mailboxes the
  Microsoft 365 sync creates later get their access on the next run.

## Why a container

No Microsoft Graph endpoint returns mailbox Full Access or Send As (v1.0 or
beta), and the Exchange Online Admin API (REST, preview) covers Send on
Behalf and folder permissions but not Full Access or Send As
([Admin API overview](https://learn.microsoft.com/en-us/exchange/reference/admin-api-overview)).
Microsoft's supported way to read them app-only is the Exchange Online
PowerShell module: `Get-EXOMailboxPermission` and `Get-EXORecipientPermission`
([module overview](https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2)),
which is officially supported in PowerShell 7 on Ubuntu 24.04. A Worker cannot
run PowerShell, so the collector runs in a
[Cloudflare Container](https://developers.cloudflare.com/containers/) started
from the email Worker's cron, the pattern Cloudflare documents in
[Cron container](https://developers.cloudflare.com/containers/examples/cron/).

If Microsoft adds Full Access and Send As to the Admin API, the collector can
be replaced by plain `fetch` calls; the snapshot contract below stays the same.

## Architecture

```
email Worker, cron */15
  runM365PermsTick (apps/email-worker/src/m365-perms/sync.ts)
  ├─ switch off → return (one org_settings read, nothing else)
  ├─ due (daily) or "Sync access now" → POST /begin to the collector DO
  │     M365PermsCollector (Durable Object, collector.ts)
  │       alarm → start container (image built from container/m365-perms/Dockerfile,
  │               instance "basic", internet on, certificate NOT in the start env)
  │             → exec pwsh collect.ps1 with the certificate in that process's env only
  │             → read /tmp/cmail-out/result.json (≤ 8 MiB) or error.json
  │             → store the snapshot in Durable Object storage, destroy the container
  ├─ next tick: GET /result → strict validation (snapshot.ts)
  ├─ groups: expand group trustees with Graph transitiveMembers (groups.ts)
  ├─ diff: Exchange rights vs cmail assignments and the ledger (diff.ts)
  ├─ brake check → apply in bounded chunks with audit rows (apply.ts)
  └─ status row m365_perm_state → Admin > Shared mailbox access
```

Each step saves its place in `m365_perm_state`, so a cron run that stops at
any point resumes on the next one. Work per run is bounded (60 s, 600 D1
statements, 60 Graph requests). Logs carry codes and counts only, never
addresses or names.

**Large tenants.** The collector reads each shared mailbox with two cmdlet
calls (about 1 to 2 seconds each, unverified). It stops taking new mailboxes
after 10 minutes, writes what it has with `complete: false` and a cursor, and
the next run continues from there. Removals only ever apply to mailboxes a
run fully read, so a partial run never removes anything elsewhere. For more
than about 300 shared mailboxes, lower `M365_PERMS_INTERVAL_HOURS` (minimum 6)
so a full pass finishes sooner.

## Mapping: Exchange to cmail

Exchange rights are independent: Full Access does not allow sending, Send As
does not allow reading
([Manage permissions for recipients](https://learn.microsoft.com/en-us/exchange/recipients-in-exchange-online/manage-permissions-for-recipients)).
cmail levels include each other: Read < Send as (read + send) < Full (send +
folders, archive, delete). The rule is **never more than Exchange grants**.

| Exchange (direct and group grants combined) | cmail level | Shown as |
|---|---|---|
| Full Access + Send As | Full | `add`, `upgrade` |
| Full Access only | Read (or Full with `M365_PERMS_FULLACCESS_IMPLIES_SEND = "true"`) | `add` |
| Send As only | nothing (cmail Send as would add reading) | `not_representable` |
| Send on Behalf | not read (cmail has no on-behalf sending) | — |
| Inherited, Deny, `NT AUTHORITY\…`, bare SIDs (deleted accounts) | skipped | snapshot `skipped` counts |
| A room, equipment or shared mailbox as trustee, a contact | skipped | `otherKind` |
| A trustee not linked to a cmail person by the Microsoft 365 sync | skipped | `trusteeNotLinked` |
| A paused, offboarded or out-of-scope person | no new access (existing sync-made access follows Exchange) | `account_not_active` |
| A shared mailbox the Microsoft 365 sync has not linked yet | skipped until linked | `mailboxNotLinked` |

Mapping is by Entra object id only (Exchange `ExternalDirectoryObjectId`, the
same id the Microsoft 365 sync links on), never by address or name.
Mail-enabled security groups are expanded with Microsoft Graph
`GET /groups/{id}/transitiveMembers/microsoft.graph.user`
([list transitive members](https://learn.microsoft.com/en-us/graph/api/group-list-transitivemembers)),
using the Microsoft 365 sync's own read-only app (`GroupMember.Read.All`).
Without that app, or if a group cannot be read, mailboxes granting that group
count as not fully read (no removals there).

## Safety rules

1. **Off means off.** See "In short". Turning it off mid-run stops before the
   next write; assignments stay as they are.
2. **Ownership ledger.** Every assignment the sync writes gets a row in
   `m365_perm_ledger` with the level and an exact `assigned_at` marker in
   millisecond precision (every other writer stamps `datetime('now')`, which
   has no fraction). The sync changes or removes an assignment only while the
   live row still has that marker, that level and no `assigned_by`.
3. **Manager wins, automatically.** Two triggers (migration `0028`) drop the
   ledger row when anyone deletes the assignment, or updates it to another
   marker or with an `assigned_by` (Admin > Mailboxes re-assign does both).
   From then on the row is the manager's and the sync never touches it, even
   if Exchange no longer grants it. Exchange granting more than a manager set
   is reported as `manager_kept`, never applied.
4. **Guarded writes.** Each change is one D1 batch with its audit row
   (`mailbox.assigned`, `mailbox.permission_changed`, `mailbox.unassigned`,
   actor `system`). Every statement re-checks what the diff read, so a
   concurrent manager change wins and is counted as `changedConcurrently`.
   Personal mailboxes are never written (and the `0006` triggers would refuse).
5. **Shared mailboxes only**, and only those linked by the Microsoft 365 sync.
6. **Removals need a full read.** A mailbox is removable only when the
   snapshot lists it with `complete: true` and every group on it was expanded.
   A mailbox missing from the snapshot, or marked incomplete (a cmdlet failed,
   a trustee could not be resolved), keeps all its rows (`mailboxNotCovered`).
7. **Removal brake** (same style as the Microsoft 365 sync's mass-pause brake).
   Removals and downgrades wait for a manager (additions still apply) when:
   - they are at least 5 and more than `M365_PERMS_MAX_REMOVE_PERCENT`
     (default 20) of the grants the sync owns: approvable;
   - the snapshot lists shared mailboxes but no grant at all: approvable;
   - Exchange lists no shared mailboxes at all while the sync owns grants:
     **never approvable** (a wrong tenant or a lost role, not "nobody has
     access").
   Approve applies to that exact round only. **Discard and collect again**
   (or Sync access now) drops it. A held round expires after 30 hours, so a
   snapshot older than 36 hours is never applied.
8. **Strict snapshot validation.** Exact keys, versions, GUIDs, addresses,
   counts and sizes (8 MiB, 20,000 mailboxes, 5,000 grants per mailbox),
   tenant id and organisation must match this deployment, `collectedAt` at
   most 36 hours old. Anything else rejects the whole snapshot (`bad_snapshot`).

MCP (AI app) mailbox access is checked against `mailbox_assignments` at call
time, so a removed assignment takes effect on the next request.

## Failure modes

| What happens | Behaviour | Admin shows |
|---|---|---|
| Switch off | Nothing runs | Off |
| Worker settings or container binding missing | Nothing runs; setting names listed | `not_configured` |
| Certificate wrong or expired, app or consent missing | No change; retry after back-off | `credentials_rejected`, `certificate_unreadable`, `connect_failed` |
| Exchange role missing a cmdlet | No change | `exchange_role_missing` or `unauthorized` |
| Container fails to start, crashes, is killed after 13 minutes | No change | `collector_failed`, `collector_timeout`, `no_container`, `no_image` |
| Collector still running after 25 minutes | Round dropped, no change | `collector_timeout` |
| Bad JSON, wrong schema, wrong tenant, too large, too old | Whole snapshot rejected, no change | `bad_snapshot` |
| One mailbox's query failed or a trustee unresolved | That mailbox: additions only, no removals | `mailboxNotCovered` |
| A group cannot be expanded | Mailboxes with that group: additions only | `mailboxNotCovered` |
| Throttling | The module retries; a failing mailbox becomes incomplete | `sendas_query_failed` / `fullaccess_query_failed` in the snapshot |
| A manager changes a row meanwhile | Manager wins | `changedConcurrently` |

Every failure ends the round with nothing changed, counts a consecutive
failure and backs off (1, 2, 4, 8, 16 hours, then 24). **Sync access now**
skips the back-off. After 3 failures in a row Admin shows a red alert; one
good run clears it.

## Snapshot contract (version 1)

The collector writes exactly this (any other key is rejected):

```json
{
  "schema": "cmail-exo-permissions",
  "version": 1,
  "tenantId": "<tenant GUID>",
  "organization": "<name>.onmicrosoft.com",
  "collectedAt": "2026-11-16T00:00:00.000Z",
  "complete": true,
  "nextCursor": "",
  "mailboxCount": 1,
  "mailboxes": [
    { "id": "<shared mailbox ExternalDirectoryObjectId>", "address": "desk@example.test", "complete": true,
      "grants": [ { "trustee": "<user or group object id>", "kind": "user", "fullAccess": true, "sendAs": true } ] }
  ],
  "skipped": { "inherited": 0, "deny": 0, "system": 0, "orphaned": 0, "unresolved": 0, "otherKind": 0 },
  "errors": [ { "code": "sendas_query_failed", "count": 1 } ]
}
```

No names of trustees, no SIDs and no mail content leave the container; the
only addresses are the shared mailboxes' own primary addresses (for reports).

## Cost

Containers need the **Workers Paid** plan (USD 5 a month), which includes
375 vCPU-minutes, 25 GiB-hours of memory and 200 GB-hours of disk a month;
billing is per 10 ms while the container runs
([Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)).

The collector uses the `basic` instance (1/4 vCPU, 1 GiB, 4 GB disk) for one
run a day, up to about 13 minutes at worst:

| Resource | Worst case a month (30 runs × 13 min) | Included | Extra cost |
|---|---|---|---|
| Memory | 1 GiB × 6.5 h = 6.5 GiB-h | 25 GiB-h | 0 |
| CPU (active only) | ≤ 0.25 vCPU × 390 min = 98 vCPU-min | 375 | 0 |
| Disk | 4 GB × 6.5 h = 26 GB-h | 200 GB-h | 0 |
| Egress | well under 1 GB | 500 GB+ | 0 |

So **no cost beyond Workers Paid** at a daily cadence (estimate). At the
6-hour minimum the worst case is four times that, still inside the included
amounts. Durable Object and D1 use is a handful of requests a day. Image
storage in Cloudflare's registry was not found priced separately (unverified).

## Setup

Do this in a **test tenant first**. Steps 1 to 4 are in Microsoft 365, 5 to
8 in Cloudflare and cmail.

### 1. Entra app (separate from the directory sync app)

Follow Microsoft's
[App-only authentication](https://learn.microsoft.com/en-us/powershell/exchange/app-only-auth-powershell-v2):

1. App registrations > New registration: name `cmail Exchange permission reader`,
   single tenant, no redirect URI.
2. API permissions > Add > APIs my organization uses > **Office 365 Exchange
   Online** > Application permissions > **Exchange.ManageAsApp**. Grant admin
   consent. Remove admin consent from the default Graph `User.Read`.
3. Note the Application (client) ID: this is `M365_EXO_APP_ID`.

### 2. Certificate (CSP key; CNG is not supported for this)

On Windows, in PowerShell as administrator:

```powershell
$cert = New-SelfSignedCertificate -Subject "CN=cmail Exchange permission reader" `
  -CertStoreLocation "Cert:\CurrentUser\My" -KeySpec KeyExchange `
  -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(1)
$password = Read-Host -AsSecureString "PFX password"
$cert | Export-PfxCertificate -FilePath .\cmail-exo-reader.pfx -Password $password
$cert | Export-Certificate -FilePath .\cmail-exo-reader.cer
```

Upload the `.cer` under the app's Certificates & secrets. Record the expiry
date and renew before it (the collector then fails with
`credentials_rejected`; access stays as it is).

### 3. Exchange role: read-only, least privilege

The app gets a custom role group holding only the read cmdlets the collector
uses. Connect as an Exchange administrator (delegated) first:

```powershell
Connect-ExchangeOnline -UserPrincipalName admin@<tenant>.onmicrosoft.com

# a. See which built-in roles hold each cmdlet in YOUR tenant (do not assume).
$needed = 'Get-Mailbox','Get-MailboxPermission','Get-RecipientPermission','Get-Recipient'
foreach ($cmd in $needed) { Get-ManagementRoleEntry -Identity "*\$cmd" | Select-Object Role, Name }

# b. A custom role whose parent holds all four (expected: "Mail Recipients";
#    use the role step a showed if different), trimmed to the reads only.
New-ManagementRole -Name "cmail Mailbox Access Reader" -Parent "Mail Recipients"
Get-ManagementRoleEntry "cmail Mailbox Access Reader\*" |
  Where-Object { $needed -notcontains $_.Name } |
  ForEach-Object { Remove-ManagementRoleEntry -Identity "cmail Mailbox Access Reader\$($_.Name)" -Confirm:$false }
Get-ManagementRoleEntry "cmail Mailbox Access Reader\*" | Select-Object Name   # must list exactly the four

# c. A role group with only that role.
New-RoleGroup -Name "cmail Mailbox Access Readers" -Roles "cmail Mailbox Access Reader" `
  -Description "Read-only: Full Access and Send As on shared mailboxes for cmail"

# d. The app's service principal in Exchange, added to the group.
#    ObjectId = the Enterprise application's Object ID (not the app registration's).
Connect-MgGraph -Scopes Application.Read.All
$sp = Get-MgServicePrincipal -Filter "DisplayName eq 'cmail Exchange permission reader'"
New-ServicePrincipal -AppId $sp.AppId -ObjectId $sp.Id -DisplayName "cmail Exchange permission reader"
Add-RoleGroupMember -Identity "cmail Mailbox Access Readers" -Member $sp.Id
```

`Get-EXOMailbox`, `Get-EXOMailboxPermission`, `Get-EXORecipientPermission` and
`Get-EXORecipient` are the REST versions of `Get-Mailbox`,
`Get-MailboxPermission`, `Get-RecipientPermission` and `Get-Recipient`
([module overview](https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2));
that they are authorised by these four role entries is **unverified** and is
what step 4 checks.

**Unverified, check in the test tenant:**
- Which built-in role holds `Get-RecipientPermission`. Community reports say
  it is missing from View-Only Recipients and View-Only Organization
  Management, and that Global Reader cannot run it
  ([MVP article](https://michev.info/blog/post/935/recipient-permissions-send-as-missing-from-the-default-view-only-organization-management-role-group),
  [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/327977/get-recipientpermission-and-get-exorecipientpermis)).
  Hence the custom role, with the parent taken from step 3a.
- Whether `Get-Recipient` is needed beside `Get-EXORecipient` (kept in the role
  to be safe; it is read-only).

Fallback if the custom role cannot be built: the Entra role **Global Reader**
(read-only, tenant-wide, listed as supported for app-only access), but it may
not cover `Get-RecipientPermission` (see above).

### 4. Prove the role from your own PC

```powershell
$pfx = Get-PfxCertificate -FilePath .\cmail-exo-reader.pfx   # prompts for the password
Connect-ExchangeOnline -Certificate $pfx -AppId <M365_EXO_APP_ID> -Organization <tenant>.onmicrosoft.com -ShowBanner:$false
$m = Get-EXOMailbox -RecipientTypeDetails SharedMailbox -ResultSize 1
Get-EXOMailboxPermission -Identity $m.PrimarySmtpAddress
Get-EXORecipientPermission -Identity $m.PrimarySmtpAddress -AccessRights SendAs
Get-EXORecipient -Identity $m.PrimarySmtpAddress | Select-Object ExternalDirectoryObjectId, RecipientTypeDetails
# Must FAIL (not recognised, or access denied): proves the role cannot write.
Add-MailboxPermission -Identity $m.PrimarySmtpAddress -User nobody@example.test -AccessRights FullAccess -WhatIf
Disconnect-ExchangeOnline -Confirm:$false
```

Also note what `User` and `Trustee` look like in the output (UPN, name or
SID). The collector resolves each with `Get-EXORecipient`; any it cannot
resolve marks that mailbox incomplete (no removals there).

### 5. Worker settings and secrets

In `apps/email-worker/wrangler.toml` (`[vars]`): `M365_TENANT_ID` (already set
for the Microsoft 365 sync), `M365_EXO_APP_ID`, `M365_EXO_ORGANIZATION`
(`<name>.onmicrosoft.com`), optionally `M365_PERMS_INTERVAL_HOURS`,
`M365_PERMS_MAX_REMOVE_PERCENT`, `M365_PERMS_FULLACCESS_IMPLIES_SEND`.
Secrets:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('.\cmail-exo-reader.pfx')) |
  npx wrangler secret put M365_EXO_CERT_PFX_B64 --config apps/email-worker/wrangler.toml
npx wrangler secret put M365_EXO_CERT_PASSWORD --config apps/email-worker/wrangler.toml
```

Then delete the local `.pfx` copy or keep it only in a password manager.

### 6. Container block

Uncomment the container block at the end of
`apps/email-worker/wrangler.toml.example` in your `wrangler.toml`
(`[[containers]]` with `scheduling_policy = "durable_object"` and
`images.base.dockerfile = "./container/m365-perms/Dockerfile"`, the
`M365_PERMS_COLLECTOR` Durable Object binding and its `exports` entry, as in
Cloudflare's [cron example](https://developers.cloudflare.com/containers/examples/cron/)).
`wrangler deploy` then builds the image, so Docker must run on the deploying
machine. The `durable_object` scheduling policy is **public beta**
([scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/));
the older `default` policy is deprecated. Needs Workers Paid.

The image is Ubuntu 24.04 + PowerShell `7.6.10` + ExchangeOnlineManagement
`3.11.1`, pinned in the Dockerfile and checked at build time. To update,
change the two `ARG`s, rebuild, run the harness (below) and a dry run.

### 7. Database

Apply migration `0028` (additive: three tables, two triggers) with
`pnpm db:migrate` after the owner's yes. Deploy the email Worker, then the
web app.

### 8. Turn it on

Admin > Shared mailbox access: check there is no "not configured" notice,
**Turn on** (dry run stays on), wait for two cron runs (collection, then
report), read the report. When it matches Exchange, **Turn dry run off**.

## How to test

- **Unit and integration tests** (CI): `apps/email-worker/src/m365-perms/`:
  snapshot schema rejection, mapping, diff, brake, ownership, manager rows
  untouched, failures keep access, switch off changes nothing (whole-database
  hash), dry run writes nothing, and the collector's container handling with
  a fake container. Run one file locally with
  `pnpm --filter @cmail/email-worker exec vitest run src/m365-perms`.
- **Collector harness** (no tenant): `pwsh -File apps/email-worker/container/m365-perms/collect.Tests.ps1`
  runs `collect.ps1` against mocked Exchange cmdlets (system, orphaned,
  inherited, deny, group, room and unresolvable trustees, a failed query, the
  deadline and the cursor) and checks that a write cmdlet is refused. The
  Worker test suite runs it too when `pwsh` is installed, and validates its
  output with the Worker's own validator.
- **Image build** (no tenant): `docker build apps/email-worker/container/m365-perms`.
- **Test tenant dress rehearsal** before any client: steps 1 to 8, dry run,
  then live with one shared mailbox; add and remove Full Access and Send As in
  Exchange and check each cmail change and its audit row; change a row in
  Admin > Mailboxes and check the sync leaves it alone; break the certificate
  and check nothing changes and the alert appears after 3 runs.

## Rollback

- **Stop:** Admin > Shared mailbox access > Turn off. Nothing runs; every
  assignment stays.
- **Undo its grants:** the ledger lists them:
  `SELECT mailbox_id, user_id, level_written FROM m365_perm_ledger;` Remove
  any you do not want in Admin > Mailboxes (that also clears the ledger row).
- **Remove the container:** comment the container block out again and
  redeploy the email Worker; with the binding gone the feature reports
  "not configured" and does nothing.
- **Migration 0028** is additive. Its tables can stay; dropping them is not
  needed for a rollback.
- **Entra:** remove the app's certificate or the app itself; remove the
  service principal from the role group (`Remove-RoleGroupMember`).

## Not verified yet

- A real run against Exchange Online (cmdlet output formats, trustee formats,
  timings, throttling).
- The custom Exchange role (step 3) authorising the four `Get-EXO*` cmdlets
  app-only.
- The container on Cloudflare: build, start with `enableInternet`, `exec`,
  reading the result file, the 15-minute alarm limit, and that Workers Paid
  covers it as estimated.
- `X509CertificateLoader.LoadPkcs12` with `EphemeralKeySet` for the
  certificate inside the container (Linux, .NET 10).
- D1 behaviour of `changes()` inside a batch for the removal audit row
  (tested on SQLite; D1 is SQLite).
