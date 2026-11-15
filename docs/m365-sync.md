# Microsoft 365 mailbox sync

Optional and off by default. When a manager turns it on, the email Worker
reads the organisation's Microsoft 365 (Entra ID) users on a schedule and keeps
cmail in step: new licensed users get a pending account and a personal
mailbox, and people who are disabled, unlicensed or removed are paused. It
only ever **reads** from Microsoft, and it never deletes mail or mailboxes.

This is the directory half of using cmail as a standby for Exchange Online:
the people who would need the standby already have accounts when it is
needed. Sign-in itself is separate (Google, Microsoft, an email code, or the
[Cloudflare Access bridge](staff-sign-in.md#cloudflare-access-bridge), which
adopts synced pending accounts on a first visit).

- Code: `apps/email-worker/src/m365-sync/` (Graph client, rules, apply,
  scheduled driver), `packages/shared/src/m365-sync.ts` (switch, config check,
  status types), `apps/web/src/lib/server/m365-sync-admin.ts` and
  `apps/web/src/routes/admin/m365-sync/` (the Admin page).
- Data: migration `0022_m365_sync.sql` (`m365_sync_links`,
  `m365_sync_state`); the switch lives in `org_settings`.
- Tests: `apps/email-worker/src/m365-sync/*.test.ts` and
  `apps/web/src/lib/server/m365-sync-admin.test.ts`.

## How it works

```mermaid
flowchart LR
  admin["Admin > Microsoft 365 sync<br/>(manager switch)"] -->|org_settings| d1[(D1)]
  cron["Email Worker cron<br/>*/15 * * * *"] --> sw{"Switch on?"}
  sw -->|no| stop["Return. No Graph call, no write"]
  sw -->|yes| graph["Microsoft Graph v1.0<br/>users/delta, $batch checkMemberGroups"]
  graph --> rules["Rules: which objects count"]
  rules --> apply["Apply: create, adopt, update,<br/>pause, resume (or report in dry run)"]
  apply --> d1
  admin -.->|"EMAIL_SERVICE: /internal/m365-sync/config<br/>(setting names only)"| cron
```

The web app never holds the Entra credentials and never calls Microsoft. It
writes the switch, reads the status row the Worker writes, and asks the Worker
over the private `EMAIL_SERVICE` binding whether its settings are present
(names only, never values).

## Sync points, and why these ones

| Decision | Choice | Why |
|---|---|---|
| Identity key | The Entra **object id** (`id`), stored in `m365_sync_links.object_id` | It is immutable for the life of the object. UPN and mail change on renames and domain moves; keying on them would recreate accounts. An address change updates the linked account instead. |
| Change feed | **`GET /users/delta`** with a stored `@odata.deltaLink` | Delta query is Microsoft's recommended way to track directory changes without re-reading everything, and it lowers the chance of throttling ([delta query overview](https://learn.microsoft.com/en-us/graph/delta-query-overview), [throttling guidance](https://learn.microsoft.com/en-us/graph/throttling)). It reports deletions as `@removed` (`changed` = soft-deleted, `deleted` = gone). |
| Safety net | A **full reconciliation** daily, on "Sync now", after any resync-required answer, and whenever the delta link is six days old | Directory delta tokens last seven days ([token duration](https://learn.microsoft.com/en-us/graph/delta-query-overview#token-duration)); Graph can also return `410 Gone` and ask for a full resync ([synchronization reset](https://learn.microsoft.com/en-us/graph/delta-query-overview#synchronization-reset)). Group membership changes do not appear in the users delta, so the daily pass also picks those up. A reconciliation is a fresh `users/delta` enumeration (the first round returns every current object) followed by a **sweep** that pauses linked accounts the enumeration never returned. It ends with a fresh delta link, so the same code serves both. |
| Properties | `$select=id,displayName,mail,userPrincipalName,accountEnabled,userType,assignedPlans`, once, in the first request of each round | `accountEnabled` and `assignedPlans` are only returned when selected ([user resource](https://learn.microsoft.com/en-us/graph/api/resources/user)). The delta token carries the `$select` forward, and by default every later page returns all selected properties, so each object can be judged on its own ([user: delta](https://learn.microsoft.com/en-us/graph/api/user-delta)). |
| Mailbox test | An `assignedPlans` entry with `service` `exchange` and `capabilityStatus` `Enabled` or `Warning` | That is the Exchange Online service plan from the user's licence. `Warning` is the grace period and still a working mailbox; `Suspended`, `LockedOut` and `Deleted` are not ([assignedPlan](https://learn.microsoft.com/en-us/graph/api/resources/assignedplan)). |
| Group scope | `POST /users/{id}/checkMemberGroups`, 20 objects per JSON `$batch` | Transitive (nested groups count), and works with application permissions `User.Read.All` + `GroupMember.Read.All` ([checkMemberGroups](https://learn.microsoft.com/en-us/graph/api/directoryobject-checkmembergroups)). Only objects whose address is on `MAIL_DOMAIN` are checked. |
| Throttling | Honour `Retry-After` on 429, 503 and 504. Waits of 5 s or less are retried in place (twice at most); longer ones end the run and the next cron resumes | Microsoft's guidance: wait the `Retry-After` seconds, retry, and use exponential backoff when there is no header ([throttling](https://learn.microsoft.com/en-us/graph/throttling)). Without a header the wait doubles from 60 s up to an hour. |
| Replays | Every write is keyed on the object id and guarded, and repeats are expected | Delta can return the same change more than once ([replays](https://learn.microsoft.com/en-us/graph/delta-query-overview#replays)). Repeats within one page are de-duplicated (last copy wins). |
| Bounded work | Each run stops starting new work after 60 s, 600 D1 statements or 60 Graph requests, and applies objects in chunks of 25 | Keeps every invocation well inside the Workers subrequest limits, which count D1 queries and Graph calls ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests): 10,000 per invocation on Workers Paid). A fetched page is stored in the status row and applied over as many runs as it takes, so a large page never has to fit in one run and a Graph page is never fetched twice. |
| Resumable | The round (next page link, unapplied objects, counts, report) is saved after every step | A crash, timeout or throttle loses nothing; the next run continues where this one stopped. A round older than a day, or one started in the other mode, is dropped and started again. |
| One at a time | A 10-minute lease on the status row | Two overlapping cron invocations never run a round together. |

Not used, on purpose:

- **Change notifications (webhooks).** They need a public endpoint, a
  subscription to renew every few days, and still need delta to fetch the
  change. Polling delta every hour is simpler and enough for accounts.
- **`Prefer: return=minimal`.** It would return only changed properties, so
  an object could not be judged without the old values.
- **`/users` with `$filter`.** Users delta only filters by object id; scoping
  is done by the group check instead.

## Which accounts are synced

An Entra object becomes a cmail **person** when all of these hold:

1. it is not deleted (no `@removed`);
2. its primary SMTP address (`mail`) is on `MAIL_DOMAIN` and is an address
   Admin could create (letters, digits, `.`, `_`, `-`);
3. `userType` is `Member` (guests are left out);
4. `accountEnabled` is `true`;
5. it has a usable Exchange service plan (above);
6. if `M365_SCOPE_GROUP_ID` is set, it is a member of that group (nested
   groups count).

Anything else is **out of scope**, with a reason: `deleted`, `disabled`,
`guest`, `no_mailbox_plan`, `no_address`, `other_domain`,
`not_in_scope_group`, `in_shared_group`, or `not_seen` (linked, but the full
enumeration no longer returned it).

### Shared mailboxes: what is and is not supported

Microsoft Graph has no reliable property that says "this is a shared
mailbox". In Exchange that is the mailbox's recipient type, which Graph's
user resource does not expose; a shared mailbox shows up as an ordinary user
object, usually disabled and unlicensed, which looks exactly like a leaver.
So the sync does **not** guess.

What is supported: put the shared mailboxes' user objects in one Entra group
and set `M365_SHARED_GROUP_ID`. Members of that group (with an address on
`MAIL_DOMAIN`) become cmail **shared** mailboxes, whatever their licence or
sign-in state. The sync then:

- creates the shared mailbox if no mailbox has that address, or links an
  existing shared mailbox with that address;
- assigns **no one** to it. Who can read or send as it stays a manager's
  decision in Admin > Mailboxes: Graph application permissions cannot read
  Exchange mailbox permissions, and guessing would grant mail access;
- follows a primary address change;
- **never disables it**. When it leaves the group the report says so
  (`left_source_kept`) and a manager decides. Disabling would bounce mail.

Without that group, shared mailboxes are not synced at all. Create them in
Admin as before.

A licensed person who is put in the shared group (for example a leaver whose
mailbox was converted to shared) is paused as a person (`in_shared_group`).
Their personal mailbox stays; no second mailbox is created.

## What the sync changes in cmail

| Microsoft 365 | cmail (live mode) |
|---|---|
| New in-scope person, address free | Creates a **pending** standard account, a personal mailbox at that address and the owner's Full assignment, in one batch with `user.provisioned` and `mailbox.created` audit rows |
| New in-scope person, a standard account with that address exists (pending or active) | **Adopts** it: links it, no new account (`m365_sync.user_adopted`) |
| Primary address changed | Updates the account email, and the personal mailbox address when it still carries the old address (`m365_sync.user_updated`). Never recreates |
| Display name changed | Updates the account display name |
| Leaves scope (disabled, unlicensed, deleted, out of the scope group, not seen) | **Pauses** the account once, on that change: status `paused`, sessions and AI app (MCP) tokens and grants revoked, the same steps as Admin > People > Pause (`m365_sync.user_paused`). The mailbox and its mail stay |
| Back in scope | **Resumes** only an account the sync itself paused, to its earlier status (`m365_sync.user_resumed`). The person signs in again |

Rules that always hold:

- **Nothing is deleted.** No mail, mailbox or account is ever removed. A
  manager offboards in Admin as before.
- **Managers are untouchable.** The sync never creates, adopts, pauses,
  resumes or renames a manager account. An address that belongs to a manager
  is reported as `manager_not_adopted`.
- **A manager's choice stands.** An account a manager paused is never
  resumed. An account a manager reactivated while it is still out of scope
  is not paused again until Microsoft 365 changes again (pausing happens on
  the change into "out of scope", not on every run).
- **Paused and offboarded accounts are not adopted** (`account_paused_or_offboarded`),
  and a linked account that a manager offboarded is never edited again.
- **Conflicts are reported, not forced.** An address already used by another
  mailbox (`address_in_use`), two Entra objects with the same address
  (`duplicate_source_object`), or a write that lost a race with a sign-in or a
  manager (`write_conflict`) changes nothing and appears in the report.
- **No sign-in identity is created.** Synced accounts are pending with no
  identity: the person enrols by invitation, or the Access bridge adopts the
  account on their first visit. The sync never decides who can sign in.

## The switch (Admin > Microsoft 365 sync)

Managers only. Three controls, each audited:

| Control | Default | Effect |
|---|---|---|
| Sync on / off (`org.m365_sync_toggled`) | **Off** | Off: the cron returns at once, with no Graph call and no write. Refused while migration `0022` is missing or the Worker reports missing settings |
| Dry run on / off (`org.m365_sync_dry_run`) | **On** | Dry run reads everything and records what it *would* change, but changes no account, mailbox or link. It never stores a delta link, so the first live run is always a full reconciliation |
| Sync now (`org.m365_sync_requested`) | — | Asks for a full reconciliation on the next run (within 15 minutes) |

The page also shows: last check, result and last error code, back-off time,
last full reconciliation, delta link age, how many people and shared
mailboxes are linked, the round in progress, and the last finished round's
counts plus up to 200 changes (address, change, reason).

If the Worker's settings are missing, the page lists them by name ("not
configured"). If the web app cannot ask the Worker (no `EMAIL_SERVICE`
binding), the switch still works, and the Worker records `not_configured`
itself on its next run without changing anything.

## Failure modes

| What happens | What the sync does | Shown as |
|---|---|---|
| Settings missing or malformed | Nothing. No Graph call | `not_configured` and the list of setting names |
| Migration `0022` not applied | Nothing | Admin asks for `pnpm db:migrate`; Worker logs `not_installed` |
| Client secret wrong or expired | Stops; retries in an hour | `error (credentials_rejected)` |
| Admin consent missing or permission removed (401/403) | Stops; retries in an hour | `error (unauthorized)` |
| Throttled (429/503/504) | Short waits retried in place; longer ones saved as "waiting until" and resumed from the same page | `backoff (throttled)` |
| Delta link expired or `410 Gone` | Drops the link, runs a full reconciliation at once | Logged; next round is a reconciliation |
| Network error or 5xx | Backs off 60 s, doubling to an hour | `backoff (network)` / `error` |
| Response not as expected, or a page link not on `graph.microsoft.com/v1.0/` | Stops before using it (the token is never sent anywhere else) | `error (bad_response)` |
| Worker stopped mid-run | The lease expires in 10 minutes; the next run resumes from the saved step | `running` |
| A write clashes with a sign-in or a manager edit | That object is skipped and reported | Report: `write_conflict` |
| Switch off for days | On return, a round older than a day is dropped and a reconciliation starts | — |

Logs carry outcome codes and counts only: no addresses, names, tokens or
response bodies.

## Entra app setup (least privilege)

Do this in the customer's tenant, as a Privileged Role Administrator or
Global Administrator (admin consent for application permissions needs one of
those roles).

1. **Microsoft Entra admin center > App registrations > New registration.**
   Name it, for example, "cmail directory sync (read-only)". Supported account
   types: this organisational directory only. No redirect URI.
2. **API permissions.** Remove the default delegated `User.Read`. Add
   **Microsoft Graph > Application permissions > `User.Read.All`**: the least
   privileged application permission for `users/delta`
   ([user: delta permissions](https://learn.microsoft.com/en-us/graph/api/user-delta#permissions)).
   Only if you set `M365_SCOPE_GROUP_ID` or `M365_SHARED_GROUP_ID`, also add
   **`GroupMember.Read.All`** (application). Nothing else: no mail, no
   `Directory.*`, no write permission.
3. **Grant admin consent** for the tenant, and check that each permission
   shows "Granted".
4. **Certificates & secrets > New client secret.** Choose the shortest expiry
   you will rotate on time (6 or 12 months), copy the value once, and record
   the expiry date in your secrets register.
5. Copy the **Directory (tenant) ID** and **Application (client) ID** from
   the app's Overview.
6. Groups (optional): use security groups with visible membership. Groups
   with hidden membership need an extra permission and are not evaluated
   without it ([checkMemberGroups](https://learn.microsoft.com/en-us/graph/api/directoryobject-checkmembergroups)).

The app can read every user's profile in the tenant. It cannot read mail,
cannot change anything in Entra, and cmail never sends it a write.

## Configuration

Email Worker (`apps/email-worker/wrangler.toml`, `[vars]`; examples in
`wrangler.toml.example`):

| Setting | Kind | Example | Notes |
|---|---|---|---|
| `M365_TENANT_ID` | var | `00000000-0000-0000-0000-000000000000` | Directory (tenant) ID, a GUID |
| `M365_CLIENT_ID` | var | `00000000-0000-0000-0000-000000000000` | Application (client) ID, a GUID |
| `M365_CLIENT_SECRET` | **secret** | — | `pnpm exec wrangler secret put M365_CLIENT_SECRET --config apps/email-worker/wrangler.toml`. Never a var, never in a file or a commit |
| `M365_SCOPE_GROUP_ID` | var, optional | `00000000-0000-0000-0000-000000000000` | Only members get accounts |
| `M365_SHARED_GROUP_ID` | var, optional | `00000000-0000-0000-0000-000000000000` | Members become shared mailboxes. Must differ from the scope group |
| `M365_SYNC_INTERVAL_MINUTES` | var, optional | `60` | Delta interval, 15 to 1440 |
| `MAIL_DOMAIN` | var | `example.com` | Same value as the web app's `MAIL_DOMAIN` |

The cron `*/15 * * * *` must be in `[triggers] crons`. It costs one D1 read
per run while the switch is off. Leave the preview Worker without these
settings. Public Microsoft cloud only (`graph.microsoft.com`,
`login.microsoftonline.com`); national clouds are not supported.

## Runbook

**First run.**

1. Apply migration `0022` (`pnpm db:migrate`; owner's yes for a live
   database).
2. Create the Entra app (above). Set the vars and the secret, add the cron,
   and deploy the email Worker, then the web app.
3. Open Admin > Microsoft 365 sync. It should not say "not configured".
4. Turn the sync on with **dry run on**. Within 15 minutes the report shows
   what would be created, adopted, paused and in conflict.
5. Fix conflicts at the source (Microsoft 365 or Admin), press Sync now, and
   read the new report.
6. Turn **dry run off**. The next run is a live reconciliation. Check the
   counts and the Audit log (`user.provisioned`, `m365_sync.*`).

**Daily.** Admin shows result `ok` (or `running`) and a delta link under a
day old. Check conflicts now and then.

**Errors.**

- `not_configured`: set the named settings and redeploy the Worker.
- `credentials_rejected`: the secret is wrong or expired. Create a new one,
  `wrangler secret put` it, and wait for the next run (or press Sync now after
  the hour's back-off).
- `unauthorized`: admin consent was revoked or a permission removed. Grant it
  again.
- `throttled` that keeps coming back: another app is using the tenant's
  Graph budget. Raise `M365_SYNC_INTERVAL_MINUTES`.

**Someone was paused by mistake.** Reactivate them in Admin > People. The
sync leaves them active until their Microsoft 365 state changes again. Then
fix the cause in Microsoft 365 (licence, sign-in, group).

**Rotate the secret.** Add a new secret in Entra, `wrangler secret put` it,
confirm the next run is `ok`, then delete the old secret in Entra.

**Turn it off.** Turn the switch off. Nothing else changes: accounts and
mailboxes stay as they are. To remove it completely, also remove the
secret and vars and delete the Entra app; the two tables can stay.

## How to test

Locally, single files only (the full suite runs in CI):

```sh
pnpm --filter @cmail/email-worker exec vitest run src/m365-sync
pnpm --filter @cmail/web exec vitest run src/lib/server/m365-sync-admin.test.ts
pnpm --filter @cmail/email-worker check
```

The Worker tests run every real migration on `node:sqlite` against a fake
Graph (`src/m365-sync/testing/fake-graph.ts`) with fixtures for: paging,
delta rounds, `410 Gone` and `syncStateNotFound`, 429 with long and short
`Retry-After`, a throttled `$batch` item, a rejected secret, missing consent,
disabled, guest, unlicensed, suspended licence, deleted, renamed, duplicate
addresses, existing and manager accounts, scope and shared groups, a
converted mailbox, the sweep, the lease, dry run, and a large page spread
over several bounded runs.

Against a real tenant, use a test tenant (for example a Microsoft 365
developer tenant), never a customer's, and start in dry run. The tests do not
prove a live tenant's behaviour.

## Limits

- Group membership changes are applied at the daily reconciliation or on
  Sync now, not within the hour (they are not part of the users delta).
- Mail aliases (`proxyAddresses`) are not synced; only the primary address.
- Mailbox delegation and Send As are not synced.
- One mail domain (`MAIL_DOMAIN`). Users on other domains in the tenant are
  out of scope.
- The sync needs Workers Paid: Workers Free allows only 50 external subrequests per invocation, which a run with group checks can pass.
