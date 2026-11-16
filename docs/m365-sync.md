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
adopts synced pending accounts on a first visit). Optional
[welcome emails](m365-welcome-emails.md) (off by default) tell each new
person how to sign in.

- Code: `apps/email-worker/src/m365-sync/` (Graph client, rules, apply,
  scheduled driver), `packages/shared/src/m365-sync.ts` (switch, config check,
  status types), `apps/web/src/lib/server/m365-sync-admin.ts` and
  `apps/web/src/routes/admin/m365-sync/` (the Admin page).
- Data: migration `0022_m365_sync.sql` (`m365_sync_links`,
  `m365_sync_state`); migration `0026_m365_mailbox_purpose.sql`
  (`m365_sync_mailbox_purpose`, the mailbox type cache, used only by
  [shared mailbox detection](#shared-mailboxes)); the switch lives in
  `org_settings`.
- Tests: `apps/email-worker/src/m365-sync/*.test.ts` and
  `apps/web/src/lib/server/m365-sync-admin.test.ts`.

## How it works

```mermaid
flowchart LR
  admin["Admin > Microsoft 365 sync<br/>(manager switch)"] -->|org_settings| d1[(D1)]
  cron["Email Worker cron<br/>*/15 * * * *"] --> sw{"Switch on?"}
  sw -->|no| stop["Return. No Graph call, no write"]
  sw -->|yes| graph["Microsoft Graph v1.0<br/>users/delta, $batch checkMemberGroups,<br/>$batch mailboxSettings/userPurpose (optional)"]
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
| Mailbox test | An `assignedPlans` entry whose `servicePlanId` is an Exchange Online **mailbox** plan (list below) and whose `capabilityStatus` is `Enabled` or `Warning` | The service name alone is not enough: Exchange Foundation (`EXCHANGE_S_FOUNDATION`) also reports service `exchange` and comes with many SKUs that have no mailbox. `Warning` is the grace period and still a working mailbox; `Suspended`, `LockedOut` and `Deleted` are not ([assignedPlan](https://learn.microsoft.com/en-us/graph/api/resources/assignedplan)). |
| Group scope | `POST /users/{id}/checkMemberGroups`, 20 objects per JSON `$batch` | Transitive (nested groups count), and works with application permissions `User.Read.All` + `GroupMember.Read.All` ([checkMemberGroups](https://learn.microsoft.com/en-us/graph/api/directoryobject-checkmembergroups)). Only objects whose address is on `MAIL_DOMAIN` are checked. |
| Shared mailbox type (optional) | With `M365_DETECT_SHARED_MAILBOXES = "true"`: `GET /users/{id}/mailboxSettings/userPurpose`, 20 per JSON `$batch`, for objects whose `mail` is on `MAIL_DOMAIN` (disabled and unlicensed ones included), cached per object id | `userPurpose` is Exchange Online's mailbox type: `user`, `linked`, `shared`, `room`, `equipment`, `others` ([mailboxSettings resource](https://learn.microsoft.com/en-us/graph/api/resources/mailboxsettings), [get mailboxSettings](https://learn.microsoft.com/en-us/graph/api/user-get-mailboxsettings), least privileged application permission `MailboxSettings.Read`). Read once per object, again at each full reconciliation, never on every delta round. Details in [Shared mailboxes](#shared-mailboxes). |
| Throttling | Honour `Retry-After` on 429, 503 and 504. Waits of 5 s or less are retried in place (twice at most); longer ones end the run and the next cron resumes | Microsoft's guidance: wait the `Retry-After` seconds, retry, and use exponential backoff when there is no header ([throttling](https://learn.microsoft.com/en-us/graph/throttling)). Without a header the wait doubles from 60 s up to an hour. |
| Replays | Every write is keyed on the object id and guarded, and repeats are expected | Delta can return the same change more than once ([replays](https://learn.microsoft.com/en-us/graph/delta-query-overview#replays)). Repeats within one page are de-duplicated (last copy wins). |
| Bounded work | Each run stops starting new work after 60 s, 600 D1 statements or 60 Graph requests, and applies objects in chunks of 25 | Keeps every invocation well inside the Workers subrequest limits, which count D1 queries and Graph calls ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests): 10,000 per invocation on Workers Paid). A fetched page is stored in the status row and applied over as many runs as it takes, so a large page never has to fit in one run. A page is fetched a second time only when its group check was throttled (the page is saved only once it is classified); nothing is applied twice. |
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
5. it has a usable Exchange Online mailbox plan (below);
6. if `M365_SCOPE_GROUP_ID` is set, it is a member of that group (nested
   groups count);
7. with [shared mailbox detection](#shared-mailboxes) on: Exchange does not
   say it is a `shared`, `room` or `equipment` mailbox. (`user`, `linked`,
   `others` and "no Exchange Online mailbox" leave rules 1 to 6 to decide,
   unchanged.)

### Exchange Online mailbox plans

Matched by service plan id (`EXCHANGE_MAILBOX_PLANS` in
`packages/shared/src/m365-sync.ts`), from Microsoft's
[Product names and service plan identifiers for licensing](https://learn.microsoft.com/en-us/entra/identity/users/licensing-service-plan-reference):

| Service plan | Id |
|---|---|
| `EXCHANGE_S_STANDARD` (Exchange Online Plan 1) | `9aaf7827-d63c-4b61-89c3-182f06f82e5c` |
| `EXCHANGE_S_ENTERPRISE` (Exchange Online Plan 2) | `efb87545-963c-4e0d-99df-69c6916d9eb0` |
| `EXCHANGE_S_DESKLESS` (Exchange Online Kiosk) | `4a82b400-a79f-41a4-b4e2-e94f5787b113` |
| `EXCHANGE_S_ESSENTIALS` (Exchange Essentials) | `1126bef5-da20-4f07-b45e-ad25d2581aa8` |
| `EXCHANGE_S_STANDARD_GOV` (Plan 1 for Government) | `e9b4930a-925f-45e2-ac2a-3f7788ca6fdd` |
| `EXCHANGE_S_ENTERPRISE_GOV` (Plan 2 for Government) | `8c3069c0-ccdb-44be-ab77-986203a67df2` |
| `EXCHANGE_S_DESKLESS_GOV` (Kiosk for Government) | `88f4d7ef-a73b-4246-8047-516022144c9f` |

Not mailbox plans, so never enough on their own: `EXCHANGE_S_FOUNDATION`
(`113feb6c-3fe4-4440-bddc-54d774bf0318`), `EXCHANGE_S_FOUNDATION_GOV`,
Exchange Online Archiving (`EXCHANGE_S_ARCHIVE_ADDON`, `EXCHANGE_S_ARCHIVE`)
and MyAnalytics (`EXCHANGE_ANALYTICS`). Microsoft adds plans over time: to
accept another one, add its id to `M365_EXTRA_MAILBOX_PLAN_IDS` (comma
separated) after checking it in that reference. Run a dry run first.

Anything else is **out of scope**, with a reason: `deleted`, `disabled`,
`guest`, `no_mailbox_plan`, `no_address`, `other_domain`,
`not_in_scope_group`, `in_shared_group` or `shared_mailbox` (a shared
mailbox, from the group or from Exchange), `resource_mailbox` (a room or
equipment mailbox, detection on), or `not_seen` (linked, but the full
enumeration no longer returned it).

### Shared mailboxes

In Entra a shared mailbox is an ordinary user object, usually **disabled and
unlicensed**, which looks exactly like a leaver; the user resource does not
say "shared". So the sync never guesses from licences or sign-in state. There
are two ways to tell it, and they can be used together:

1. **A group** (`M365_SHARED_GROUP_ID`): put the shared mailboxes' user
   objects in one Entra group. Members (with an address on `MAIL_DOMAIN`)
   are shared mailboxes. Report reason `in_shared_group`.
2. **Exchange's mailbox type** (`M365_DETECT_SHARED_MAILBOXES = "true"`, off
   by default): the sync asks Exchange Online for each candidate's
   `userPurpose` and takes `shared` as a shared mailbox. Report reason
   `shared_mailbox`. Needs the `MailboxSettings.Read` application permission
   (below) and migration `0026`.

Either way the object is treated as shared whatever its licence or sign-in
state, and both take the same path in cmail. The sync:

- creates the shared mailbox if no mailbox has that address, or links an
  existing shared mailbox with that address (`m365_sync.shared_adopted`). An
  address that is a personal mailbox (`address_is_personal_mailbox`) or an
  account (`address_is_an_account`) is reported and left alone;
- assigns **no one** to it. Who can read or send as it stays a manager's
  decision in Admin > Mailboxes: guessing would grant mail access;
- follows a primary address change (`m365_sync.shared_updated`);
- **never disables it** and never deletes it or its mail. When it is deleted
  in Microsoft 365, leaves the group, is converted back to a user mailbox or
  is no longer returned, the report says so (`left_source_kept`, or
  `not_seen` from the sweep), the link is marked out of scope and a manager
  decides. Disabling would bounce mail. If it becomes shared again, the link
  is back in scope.

A group member is shared whatever Exchange says (no lookup is made for it).
When `M365_SCOPE_GROUP_ID` is set, it also limits **detected** shared
mailboxes: a shared mailbox found from its type must be a member of the
scope group (add the shared mailbox's user object to the group), or it is
`not_in_scope_group`. Members of the explicit shared group are not limited
by the scope group.

A person already linked whose mailbox becomes shared (for example a leaver
whose mailbox was converted, by group or by type) is paused as a person
(`in_shared_group` or `shared_mailbox`), through the mass-pause brake. Their
personal mailbox and its mail stay; no second mailbox is created. A manager
can then decide what to do with it.

#### How detection works

- **Candidates.** Every object in a fetched page that is not deleted and
  whose `mail` is on `MAIL_DOMAIN`, including disabled and unlicensed ones
  (that is what a shared mailbox looks like), except members of the shared
  group.
- **Call.** `GET /users/{id}/mailboxSettings/userPurpose`, sent as JSON
  `$batch` requests of 20 ([JSON batching](https://learn.microsoft.com/en-us/graph/json-batching)).
  The answer is `{ "value": "shared" }`
  ([get mailboxSettings](https://learn.microsoft.com/en-us/graph/api/user-get-mailboxsettings), example 4).
  Permission: `MailboxSettings.Read` (application), the least privileged one
  for this call.
- **Values.** `shared`: shared mailbox. `room`, `equipment`: never a person,
  even when licensed and enabled (Teams Rooms resource accounts are);
  reason `resource_mailbox`. `user`, `linked`, `others`: the licensed-person
  rule above, unchanged. `unknownFutureValue` or any value Microsoft adds
  later is read as `others`, never as shared
  ([userPurpose values](https://learn.microsoft.com/en-us/graph/api/resources/mailboxsettings#userpurpose-values)).
- **No Exchange Online mailbox.** Graph answers `404` (typically
  `MailboxNotEnabledForRESTAPI`: "inactive, soft-deleted, or hosted
  on-premise"; [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/1803734/getting-mailboxnotenabledforrestapi-error-when-try)).
  This is the normal answer for a user without an Exchange licence, but also
  for a new mailbox Exchange has not finished provisioning. So:
  - in a **full reconciliation** the sync stores `none` and the
    licensed-person rule decides, as without detection;
  - in a **delta round** nothing is stored, a linked person is judged by the
    licensed-person rule as usual (a lost licence still pauses), and a new,
    unlinked object is **not created** yet (`wait_for_mailbox`,
    `mailbox_not_provisioned`): it may turn out to be a room or a shared
    mailbox. It is asked again the next time Graph returns it, and the next
    full reconciliation decides for good.
- **Lookup failed.** A `401`/`403` for one mailbox (`mailbox_type_denied`) or
  any other error (`mailbox_type_failed`) leaves that object **exactly as it
  is** for the round: nothing is created, updated or paused, and it still
  counts as seen, so the sweep does not pause it either. No answer is
  stored, so it is asked again **the next time Graph returns the object**:
  in a delta round only if the object changed in Entra, otherwise at the
  next full reconciliation (daily, or Sync now). Admin counts these as
  "Type unknown" and warns. Each full reconciliation in which an object's
  lookup fails adds one to its consecutive-failure count (a delta round
  neither adds nor resets; any answer resets it). When a **linked** account
  or shared mailbox reaches **3**, Admin shows a "Mailbox type unreadable"
  alert and one `m365_sync.type_unreadable` audit row is written for it. A
  `401`/`403` for the whole `$batch` request stops the run
  (`unauthorized`), like any other missing consent.
- **Throttling.** A throttled item (429, 503, 504) or a throttled `$batch`
  stops the run with the longest `Retry-After` (Outlook limits are per app
  and mailbox: 10,000 requests per 10 minutes and four concurrent requests;
  Graph sends at most four requests of a batch to Outlook at a time;
  [Outlook service limits](https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits)).
  The answers already read are kept (live runs); the page is read again on
  resume and only the unanswered objects are asked again. Nothing from that
  page is applied before every candidate has an answer.
- **Cache** (`m365_sync_mailbox_purpose`, migration `0026`). One row per
  object id with its type, the round that read it and the failure count; no
  address, name or mail. A delta round asks only objects with no stored
  answer. A full reconciliation (daily, or Sync now) asks every candidate
  again once, then deletes rows it did not refresh, so a conversion in
  Exchange is picked up within a day. Deleted objects lose their row at
  once.
- **Switching detection on** (first time, or again after it was off): the
  Worker clears the whole cache, drops any round in progress (a held one
  too) and runs a **full reconciliation** next, whatever was due. So an
  answer from an earlier period (a mailbox converted meanwhile) is never
  used, and existing shared mailboxes are found at once.
- **Budget.** The lookups count towards the run's Graph request budget. The
  budget is checked before every `$batch`, with a ceiling of twice the
  per-run budget (120 requests) so one full page of 999 objects always fits
  in a run; if it runs out, the page is not applied and is read again in
  the next run (live runs keep the answers already read). Roughly one
  request per 20 on-domain objects per reconciliation, and one per 20 new
  or uncached objects in a delta round.
- **Dry run** reads the types but never writes the cache (every dry run is a
  full reconciliation, which reads every object anyway), and reports what it
  would create (`create_shared`, reason `shared_mailbox`).
- **Report wording.** With detection off, a group shared mailbox that leaves
  the group is reported as before (`not_in_shared_group`, "Left Microsoft
  365 group"); with it on, as `no_longer_shared`.

Without either option, shared mailboxes are not synced at all. Create them
in Admin as before.

## What the sync changes in cmail

| Microsoft 365 | cmail (live mode) |
|---|---|
| New in-scope person, address free | Creates a **pending** standard account, a personal mailbox at that address and the owner's Full assignment, in one batch with `user.provisioned` and `mailbox.created` audit rows |
| New in-scope person, a standard account with that address exists (pending or active) | **Adopts** it: links it, no new account (`m365_sync.user_adopted`) |
| Primary address changed | Updates the account email, and the personal mailbox address when it still carries the old address (`m365_sync.user_updated`). Never recreates |
| Display name changed | Updates the account display name (`m365_sync.user_updated`) |
| Leaves scope (disabled, unlicensed, deleted, out of the scope group, not seen) | **Pauses** the account once, on that change, after the [mass-pause brake](#mass-pause-brake) check: status `paused`, sessions and AI app (MCP) tokens and grants revoked with the same shared function Admin > People > Pause uses (`pausedAccountLockoutStatements`), and `m365_sync.user_paused`. The mailbox and its mail stay |
| Back in scope | **Resumes** only an account the sync itself paused and nobody has changed since, to its earlier status (`m365_sync.user_resumed`). The person signs in again |

Rules that always hold:

- **Nothing is deleted.** No mail, mailbox or account is ever removed. A
  manager offboards in Admin as before.
- **Managers are untouchable.** The sync never creates, adopts, pauses,
  resumes or renames a manager account. An address that belongs to a manager
  is reported as `manager_not_adopted`.
- **A manager's choice stands.** Any status change to an account, by Admin
  or anything else, clears the sync's "paused by sync" mark in the same
  statement (trigger `trg_m365_sync_status_change`, migration `0022`). So an
  account a manager paused, or reactivated and paused again, is never
  resumed by the sync. An account a manager reactivated while it is still
  out of scope is not paused again until Microsoft 365 changes again
  (pausing happens on the change into "out of scope", not on every run).
- **Status changes are conditional.** A pause or resume only changes an
  account from the status the sync just read, and stamps `updated_at` with a
  marker no other writer produces. The "paused by sync" mark and the audit
  row are written only if that marker landed. A manager action at the same
  moment wins, and the sync reports `changed_concurrently`.
- **Paused and offboarded accounts are not adopted** (`account_paused_or_offboarded`),
  and a linked account that a manager offboarded is never edited again.
- **Conflicts are reported, not forced.** An address already used by another
  mailbox (`address_in_use`), two Entra objects with the same address
  (`duplicate_source_object`), or a write that lost a race with a sign-in or a
  manager (`write_conflict`) changes nothing and appears in the report.
- **No sign-in identity is created.** Synced accounts are pending with no
  identity: the person enrols by invitation, or the Access bridge adopts the
  account on their first visit. The sync never decides who can sign in.

## Mass-pause brake

A wrong tenant, a removed licence group, an outage that returns an empty
list, or a bad scope-group change can make it look as if everyone left. The
sync therefore queues every pause during a round and checks the queue before
applying any of them. A live round is **held** when:

- it would pause at least 5 people **and** more than
  `M365_SYNC_MAX_PAUSE_PERCENT` (default 20) percent of the people currently
  linked and in scope; or
- it is a full reconciliation that returned **no** directory objects at all
  while people are linked.

A held round changes no account. New accounts and address or name updates
from the same round may already be applied; only pauses wait. Admin shows
"Large change held for approval" with the count, the percentage and up to
200 of the accounts that would be paused. A manager then either:

- presses **Approve large change** (`org.m365_sync_approved`). This approves
  that exact round id only. The next run applies the queued pauses, checking
  each account again first. An empty result cannot be approved; or
- fixes the cause in Microsoft 365 and presses **Discard and sync again**
  (Sync now). The held round is dropped and a fresh reconciliation starts.

While a round is held, no other round runs. A held round is dropped after 7
days. In dry run the brake never holds; the report says the round would have
been held.

## The switch (Admin > Microsoft 365 sync)

Managers only. Three controls, each audited:

| Control | Default | Effect |
|---|---|---|
| Sync on / off (`org.m365_sync_toggled`) | **Off** | Off: the cron returns at once, with no Graph call and no write. Refused while migration `0022` is missing or the Worker reports missing settings |
| Dry run on / off (`org.m365_sync_dry_run`) | **On** | Dry run reads everything and records what it *would* change. It changes no account, mailbox or audit log, creates no link, and changes no link's state; the only write is the bookkeeping column `seen_round` on existing links (which links the reconciliation saw). It never stores a delta link, so the first live run is always a full reconciliation |
| Sync now (`org.m365_sync_requested`) | — | Asks for a full reconciliation on the next run (within 15 minutes) |

The page also shows: last check, result and last error code, back-off time,
last full reconciliation, delta link age, how many people and shared
mailboxes are linked, whether shared mailbox detection is on, the round in
progress, and the last finished round's counts (including **Shared found**,
**Shared created** and **Type unknown**) plus up to 200 changes (address,
change, reason). Detection itself is a Worker setting, not a switch on this
page.

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
| Detection on, migration `0026` not applied | Nothing. No Graph call | `error (migration_0026_missing)` |
| Detection on, `MailboxSettings.Read` missing or not consented | A refused `$batch` stops the run (`unauthorized`); refused items leave their objects unchanged | `error (unauthorized)`, or "Type unknown" counts and a warning |
| One mailbox type lookup fails | That object is left exactly as it is, and asked again when Graph next returns it (a delta round if it changed, else the next full reconciliation) | Report: `type_unknown` with `mailbox_type_denied` or `mailbox_type_failed`; after 3 failed reconciliations in a row for a linked object, an Admin alert and `m365_sync.type_unreadable` |
| Detection on, a delta round gets 404 for a new object | Not created yet; asked again when next returned; the full reconciliation decides | Report: `wait_for_mailbox` |
| D1 error while checking for migration `0026` | Treated as an error and retried with back-off, never as a missing migration | `error (internal)` |
| Delta link expired, `410 Gone`, or a 40X with `syncStateNotFound`, `syncStateInvalid`, `resyncRequired` or a similar token error | Drops the link, runs a full reconciliation at once | Logged; next round is a reconciliation |
| A round would pause too many people, or a reconciliation returns nothing | Holds the round; no pause is applied | `held`, with the list and Approve / Discard |
| A manager pauses, reactivates or offboards someone while the sync runs | The manager's change wins; the sync's change is skipped | Report: `changed_concurrently` |
| Network error or 5xx | Backs off 60 s, doubling to an hour. A network error logs the underlying error's name only (for example `TypeError`, `TimeoutError`), never its message | `backoff (network)` / `error` |
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
   **`GroupMember.Read.All`** (application). Only if you set
   `M365_DETECT_SHARED_MAILBOXES = "true"`, also add
   **`MailboxSettings.Read`** (application), the least privileged
   permission for reading `userPurpose`
   ([get mailboxSettings permissions](https://learn.microsoft.com/en-us/graph/api/user-get-mailboxsettings#permissions)).
   Nothing else: no mail, no `Directory.*`, no write permission.
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
cannot change anything in Entra, and cmail never sends it a write. With
`MailboxSettings.Read` it can also read every mailbox's settings (time zone,
working hours, automatic-reply text and mailbox type), though cmail only
ever asks for the mailbox type. Exchange's
[RBAC for Applications](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
can grant `Application MailboxSettings.Read` to a scope of mailboxes instead
of the tenant-wide consent; if you do, the scope must cover every mailbox on
`MAIL_DOMAIN`, because an object outside it gets `403` and is then never
changed by the sync (not created, not paused).

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
| `M365_SYNC_MAX_PAUSE_PERCENT` | var, optional | `20` | Mass-pause brake threshold, 1 to 100 (with a floor of 5 pauses) |
| `M365_EXTRA_MAILBOX_PLAN_IDS` | var, optional | (empty) | Extra Exchange mailbox service plan ids, comma separated |
| `M365_DETECT_SHARED_MAILBOXES` | var, optional | `false` | `"true"` finds shared mailboxes from Exchange's mailbox type. Needs `MailboxSettings.Read` (application) with admin consent, and migration `0026`. Works alongside `M365_SHARED_GROUP_ID` |
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

**Turn on shared mailbox detection.**

1. Apply migration `0026` (`pnpm db:migrate`; owner's yes for a live
   database).
2. Add `MailboxSettings.Read` (application) to the Entra app and grant admin
   consent.
3. Turn **dry run on** in Admin, set `M365_DETECT_SHARED_MAILBOXES = "true"`
   and redeploy the email Worker. Admin shows "Shared mailbox detection: On"
   after the next run.
4. Read the report: `create_shared` and `adopt_shared` rows with reason
   `shared_mailbox`, "Shared found", and any pauses with reason
   `shared_mailbox` or `resource_mailbox` (people linked earlier who are
   really shared, room or equipment mailboxes). "Type unknown" for everyone
   means the permission or consent is missing.
5. Turn dry run off. A large first change is held by the mass-pause brake
   like any other.

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

**A round is held.** Read the list on the Admin page. If the pauses are
real (for example a planned licence removal), press Approve large change.
If not, fix the cause in Microsoft 365 (tenant, permission, licence group,
scope group) and press Discard and sync again.

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

`shared-detection.sql.node.test.ts` covers shared mailbox detection: off by
default, a bad setting value, migration `0026` missing, `shared` (disabled
and unlicensed), `user`, `room`, `equipment`, unknown future values, `404`,
a denied and a failed lookup (nothing paused or created, still counted as
seen, asked again), repeated failures (count per reconciliation, alert and
one audit row at 3, reset on an answer, a re-read page not counted twice),
switching detection on (stale answers cleared, full reconciliation at once;
off and on again), a delta 404 (not stored; a shared mailbox found when next
returned; a new licensed room not created as a person), a cached `user` for a
disabled linked person in a delta round, the per-`$batch` budget, a
throttled item and a throttled `$batch` (Retry-After, answers kept, only the
rest asked again), the cache (not read again on delta
rounds, read again and pruned at the reconciliation, forgotten on delete), a
conversion of a linked person, dry run, an existing shared mailbox, personal
mailbox or account at the same address, address change, deletion and
conversion back (never disabled), use with the shared and scope groups, and
the mass-pause brake on a first detection run.

The Worker tests run every real migration on `node:sqlite` against a fake
Graph (`src/m365-sync/testing/fake-graph.ts`) with fixtures for: paging,
delta rounds, `410 Gone` and `syncStateNotFound`, 429 with long and short
`Retry-After`, a throttled `$batch` item, a rejected secret, missing consent,
disabled, guest, unlicensed, suspended licence, a Foundation-only licence,
deleted, renamed, display-name-only changes, duplicate addresses, existing,
manager and offboarded accounts, scope and shared groups, a shared mailbox
rename, a converted mailbox, the sweep, the lease, dry run on a fresh and on
a linked directory, and a large page spread over several bounded runs.
`safety.sql.node.test.ts` covers the review findings: a manager's
reactivate-then-pause is never undone, a manager pause or offboard landing
at the same moment as the sync's pause wins, and the mass-pause brake (hold,
wrong-id approval, approval, empty result, Sync now discard, dry run).

Against a real tenant, use a test tenant (for example a Microsoft 365
developer tenant), never a customer's, and start in dry run. The tests do not
prove a live tenant's behaviour.

## Limits

- Group membership changes are applied at the daily reconciliation or on
  Sync now, not within the hour (they are not part of the users delta).
- A mailbox converted in Exchange (user to shared or back) is picked up at
  the daily reconciliation or on Sync now: the conversion itself is not in
  the users delta, and a cached type stands until then.
- Shared mailbox detection is built and tested against a fake Graph only; it
  has not yet been run against a real tenant. Start it in dry run.
- Mail aliases (`proxyAddresses`) are not synced; only the primary address.
- Mailbox delegation and Send As are not synced.
- One mail domain (`MAIL_DOMAIN`). Users on other domains in the tenant are
  out of scope.
- The sync needs Workers Paid: Workers Free allows only 50 external subrequests per invocation, which a run with group checks can pass.
