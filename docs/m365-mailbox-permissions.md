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
  it would change and writes nothing but its own status (and a temporary
  list of group members, cleared when the run ends).
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
  │               instance "standard-1", internet on, certificate NOT in the start env)
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

**Large tenants: a pass in batches.** The collector reads each shared mailbox
with two cmdlet calls (about 1 to 2 seconds each, unverified) in object id
order. One run (a batch) stops after 10 minutes, writes the mailboxes it read
and a cursor (the last id), and the Worker starts the next batch from that
cursor on the next cron run, 15 minutes later. Nothing is applied while a
pass is in progress: the Worker keeps every batch (in the collector's Durable
Object storage) until the batch that reaches the end of the list arrives,
then reads all of them back, checks that each one starts after the previous
cursor with no overlap, joins them and applies the pass **once**. The next
pass starts only after the normal interval. A pass may take at most 24
batches (about 6 hours, roughly 7,000 shared mailboxes at the estimate
above); one that needs more fails safely (`pass_too_long`, nothing changed).
Passes start at most every `M365_PERMS_INTERVAL_HOURS` (6 to 24), so at most
4 scheduled passes a day, and **Sync access now** starts one at most once an
hour.
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
| Inherited, `NT AUTHORITY\…`, bare SIDs (deleted accounts) | skipped | snapshot `skipped` counts |
| Any Deny entry on the mailbox (Full Access or Send As) | the whole mailbox is left as it is: no additions, no removals (Exchange applies Deny over group grants; cmail cannot model that) | `deny_entries`, `mailboxNotCovered` |
| An address the Worker would refuse (for example non-ASCII) | that mailbox is left out of the snapshot and left as it is | `mailbox_address_unsupported` |
| A room, equipment or shared mailbox as trustee, a contact | skipped | `otherKind` |
| A trustee not linked to a cmail person by the Microsoft 365 sync | skipped | `trusteeNotLinked` |
| A paused, offboarded or out-of-scope person | no new or raised access (existing sync-made access can still be lowered or removed when Exchange takes it away) | `account_not_active` |
| A person whose Microsoft 365 link is gone | nothing removed (a lost link is not Exchange taking access away) | — |
| A shared mailbox the Microsoft 365 sync has not linked yet | skipped until linked | `mailboxNotLinked` |

Mapping is by Entra object id only (Exchange `ExternalDirectoryObjectId`, the
same id the Microsoft 365 sync links on), never by address or name. The
collector resolves each trustee only through documented lookups:

- when the permission entry carries the trustee's SID (`UserSid` on Full
  Access entries, `TrusteeSidString` on Send As entries; these output
  properties are not listed on Microsoft Learn, so their presence is checked
  in setup step 4): `Get-User` and `Get-Group -Filter "Sid -eq '<sid>'"`
  (`Sid` is a documented filterable property of both:
  [filterable properties](https://learn.microsoft.com/en-us/powershell/exchange/filter-properties#sid)),
  then `Get-EXORecipient -Identity <that object's GUID>` (GUID is a
  documented and recommended Identity value:
  [Get-EXORecipient](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/get-exorecipient));
- otherwise `Get-EXORecipient -Identity <the value Exchange returned>`, which
  accepts a UPN, Name, alias or email address, not a display name.

Every step needs exactly one match. Anything else is unresolved and the
mailbox is left as it is (no additions or removals there).Mail-enabled security groups are expanded with Microsoft Graph
`GET /groups/{id}/transitiveMembers/microsoft.graph.user`
([list transitive members](https://learn.microsoft.com/en-us/graph/api/group-list-transitivemembers)),
with `$count=true` and `ConsistencyLevel: eventual`, because an OData cast on
directory objects is an advanced query
([advanced queries](https://learn.microsoft.com/en-us/graph/aad-advanced-queries)),
using the Microsoft 365 sync's own read-only app (`GroupMember.Read.All`).
Without that app, or if a group cannot be read, mailboxes granting that group
count as not fully read (no removals there).

## Safety rules

1. **Off means off.** See "In short". Turning it off mid-run stops before the
   next write; assignments stay as they are. The collector object also reads
   the switch before it starts the container, so a collection requested just
   before the switch went off does not run (`switched_off`).
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
   is reported as `manager_kept`, never applied. Re-saving a sync-made row in
   Admin > Mailboxes at the same level also hands it to the manager.
   **A manager's removal sticks:** deleting a sync-made assignment, or
   editing it (which hands it to the manager), records the pair in
   `m365_perm_released`, independent of the ledger. The sync never gives that
   access back while Exchange still grants it (`manager_removed`), also when
   the manager first edited the row and removed it later. The mark is cleared
   only when no assignment exists and Exchange has stopped granting it, so a
   later new grant in Exchange counts again. **Offboarding** deletes a
   person's assignments too, so it counts as a manager removal in the same way.
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
   Approve applies to that exact round and to exactly the removals and
   downgrades listed when it was held (up to 5,000; any beyond wait for the
   next round), never to new ones found later. **Discard and collect again**
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
| A pass needs more than 24 batches, or batches do not follow each other | Pass dropped, nothing applied | `pass_too_long`, `bad_snapshot` |
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

The collector uses the `standard-1` instance (1/2 vCPU, 4 GiB, 8 GB disk).
With the `durable_object` scheduling policy, `start()` accepts `lite`,
`standard-1` to `standard-4` or a custom size, not `basic`
([scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/),
[instance types](https://developers.cloudflare.com/containers/platform/limits/#instance-types)).
`lite` (256 MiB) is too small for PowerShell 7 with the Exchange module, so
`standard-1` is the smallest named size that fits (the module's memory use
is not published; estimate). One run a day, up to about 13 minutes at worst:

| Resource | Worst case a month (30 runs × 13 min = 6.5 h) | Included | Extra |
|---|---|---|---|
| Memory | 4 GiB × 6.5 h = 26 GiB-h | 25 GiB-h | 1 GiB-h ≈ USD 0.01 |
| CPU (active only) | ≤ 0.5 vCPU × 390 min = 195 vCPU-min | 375 | 0 |
| Disk | 8 GB × 6.5 h = 52 GB-h | 200 GB-h | 0 |
| Egress | well under 1 GB | 500 GB+ | 0 |

So **about USD 0.01 a month beyond Workers Paid** at a daily cadence in the
worst case, and nothing extra for typical runs of a few minutes (estimate,
unverified timings). At the 6-hour minimum the worst case is four times the
usage, about USD 1.20 a month extra. A tenant too large for one batch takes one more
batch per 15-minute cron run until the pass is complete, each up to 13 minutes. Durable Object and D1 use is a handful of requests a day.
Image storage in Cloudflare's registry was not found priced separately
(unverified).
## Setup

Onboarding a Microsoft 365 organisation end to end? See [the onboarding guide](onboarding-microsoft-365.md#11-shared-mailbox-permissions-optional), step 11, with `scripts/onboarding/perms-setup.ps1` for steps 1 to 5 below.

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

# 0. Custom roles need organization customization enabled once per tenant.
#    It is a one-time, tenant-wide switch; skip if it says it is already on.
if ((Get-OrganizationConfig).IsDehydrated) { Enable-OrganizationCustomization }

# a. The read cmdlets the collector needs, and which built-in roles hold each
#    in YOUR tenant (do not assume).
$needed = 'Get-Mailbox','Get-MailboxPermission','Get-RecipientPermission','Get-Recipient','Get-User','Get-Group'
foreach ($cmd in $needed) { Get-ManagementRoleEntry -Identity "*\$cmd" | Select-Object Role, Name }

# b. One custom role per parent role, trimmed to these reads only. Pick for
#    each cmdlet a parent that step a listed for it (expected: "Mail
#    Recipients" for all six; if one is missing there, add its parent below).
$parents = @{ 'Mail Recipients' = $needed }
$roles = foreach ($parent in $parents.Keys) {
  $name = "cmail Mailbox Access Reader ($parent)"
  New-ManagementRole -Name $name -Parent $parent | Out-Null
  Get-ManagementRoleEntry "$name\*" | Where-Object { $parents[$parent] -notcontains $_.Name } |
    ForEach-Object { Remove-ManagementRoleEntry -Identity "$name\$($_.Name)" -Confirm:$false }
  $name
}
# Must list exactly the six cmdlets, nothing else:
$roles | ForEach-Object { Get-ManagementRoleEntry "$_\*" } | Select-Object Role, Name
# c. A role group with only that role.
New-RoleGroup -Name "cmail Mailbox Access Readers" -Roles $roles `
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
that they are authorised by these role entries is **unverified** and is
what step 4 checks. `Get-User` and `Get-Group` are only used for the SID
lookups described under Mapping.

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

### 4. Go / no-go: run the real collector from your own PC

**Do not turn dry run off until this passes.** It runs the same
`collect.ps1` the container runs, as the app, against the tenant, and shows a
resolved trustee. Needs PowerShell 7.6 and ExchangeOnlineManagement 3.11.1
on your PC.

```powershell
# a. The role cannot write: this must FAIL (not recognised, or access denied).
$pfx = Get-PfxCertificate -FilePath .\cmail-exo-reader.pfx   # prompts for the password
Connect-ExchangeOnline -Certificate $pfx -AppId <M365_EXO_APP_ID> -Organization <tenant>.onmicrosoft.com -ShowBanner:$false
Add-MailboxPermission -Identity (Get-EXOMailbox -RecipientTypeDetails SharedMailbox -ResultSize 1).PrimarySmtpAddress `
  -User nobody@example.test -AccessRights FullAccess -WhatIf
# Note whether the output carries SIDs (the collector then uses the SID path):
Get-EXOMailboxPermission -Identity (Get-EXOMailbox -RecipientTypeDetails SharedMailbox -ResultSize 1).PrimarySmtpAddress |
  Select-Object User, UserSid, AccessRights
Disconnect-ExchangeOnline -Confirm:$false

# b. The collector itself, first 5 shared mailboxes.
$env:CMAIL_EXO_TENANT_ID = '<tenant GUID>'
$env:CMAIL_EXO_APP_ID = '<M365_EXO_APP_ID>'
$env:CMAIL_EXO_ORGANIZATION = '<tenant>.onmicrosoft.com'
$env:CMAIL_EXO_CERT_PFX_B64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes('.\cmail-exo-reader.pfx'))
$env:CMAIL_EXO_CERT_PASSWORD = Read-Host 'PFX password'
$env:CMAIL_BATCH_SIZE = '5'
$env:CMAIL_OUT_DIR = Join-Path $env:TEMP 'cmail-collector-test'
pwsh -NoProfile -File apps/email-worker/container/m365-perms/collect.ps1; "exit code: $LASTEXITCODE"
$r = Get-Content (Join-Path $env:CMAIL_OUT_DIR 'result.json') -Raw | ConvertFrom-Json
$r.mailboxes | Select-Object address, complete, @{ n = 'grants'; e = { $_.grants.Count } }
$r.mailboxes.grants | Select-Object -First 5 trustee, kind, fullAccess, sendAs
$r.skipped; $r.errors
Remove-Item Env:CMAIL_EXO_CERT_PFX_B64, Env:CMAIL_EXO_CERT_PASSWORD -ErrorAction SilentlyContinue
```

**Go** only when all of these hold:
1. Step a failed (the app cannot write).
2. `exit code: 0` and `result.json` exists (no `error.json`).
3. For a shared mailbox where you know a person has Full Access: it shows
   `complete = True` and a grant whose `trustee` equals that person's Object
   ID in the Entra admin center (Users > the person > Object ID). This is the
   resolved trustee.
4. `skipped.unresolved` is 0, or each unresolved entry is explained (for
   example a trustee that is not mail-enabled).

**No-go** on any other result: leave dry run on and fix the role (step 3) or
the certificate first. If no trustee resolves at all, tell the maintainers
what `User`/`UserSid` looked like in step a.
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

Apply migration `0028` (additive: four tables, two triggers) with
`pnpm db:migrate` after the owner's yes. Deploy the email Worker, then the
web app.

### 8. Turn it on

Admin > Shared mailbox access: check there is no "not configured" notice,
**Turn on** (dry run stays on), wait for two cron runs (collection, then
report), read the report. When it matches Exchange **and step 4 was a go**,
**Turn dry run off**.

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
  deadline and the cursor, SID resolution and a name collision) and checks
  that a write cmdlet is refused. CI runs it in its own job with PowerShell
  7.6.10 installed; the Worker test suite also runs it when PowerShell 7.6+
  is present (otherwise it logs that it was skipped) and validates its output
  with the Worker's own validator.
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
  needed for a rollback. If you do remove it, drop the two triggers
  (`trg_m365_perm_assignment_delete`, `trg_m365_perm_assignment_update`)
  **before** the tables: a trigger left pointing at a dropped table makes
  every later change to `mailbox_assignments` fail.
- **Entra:** remove the app's certificate or the app itself; remove the
  service principal from the role group (`Remove-RoleGroupMember`).

## Network egress

The container starts with internet access on (`enableInternet: true`): it must
reach `login.microsoftonline.com` and `outlook.office365.com`. Cloudflare
documents routing a container's outbound HTTP(S) through a Worker
(`interceptOutboundHttps`, used in the Sandbox docs to allow only some hosts),
but an allow-list for plain HTTPS to Microsoft through that path was not
verified, so it is not used yet. The script only talks to Exchange Online
through the module, holds no data beyond one snapshot, and the image carries
no secret. Restricting egress to Microsoft hosts is a planned hardening step.

## Not verified yet

- A real run against Exchange Online (cmdlet output formats, trustee formats,
  timings, throttling).
- The custom Exchange role (step 3) authorising the four `Get-EXO*` cmdlets
  app-only.
- The container on Cloudflare: build, start with `enableInternet`, `exec`,
  reading the result file, the 15-minute alarm limit, and that Workers Paid
  covers it as estimated.
- Whether `Get-EXOMailboxPermission` and `Get-EXORecipientPermission` return
  `UserSid` / `TrusteeSidString` (not listed on Learn; step 4 shows it). Without
  them the collector resolves the returned identity string instead.
- The `standard-1` size being enough memory for PowerShell 7 + the module.
- `X509CertificateLoader.LoadPkcs12` with `EphemeralKeySet` for the
  certificate inside the container (Linux, .NET 10).
- D1 behaviour of `changes()` inside a batch for the removal audit row
  (tested on SQLite; D1 is SQLite).
