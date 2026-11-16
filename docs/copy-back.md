---
title: "Copy standby mail back into Exchange"
summary: "How to copy mail cmail received during an Exchange outage back into each Exchange Online mailbox."
applies_to: standby
audience: [operator, manager]
switch: "Admin > Copy back to Exchange"
last_reviewed: 2026-11-16
related: [standby-switch.md, credentials.md, onboarding-microsoft-365.md]
---

# Copy standby mail back into Exchange

Optional and off by default. When cmail has stood in for Exchange Online
during an outage, mail that arrived in cmail meanwhile exists only in cmail.
This feature copies it into each person's Exchange Online mailbox through
Microsoft Graph, once the outage is over, so their mail history in Outlook is
complete again.

> **Status:** built, off by default, **not yet tested against a real
> Microsoft 365 tenant.** The Graph behaviour it relies on is documented by
> Microsoft or by long-standing community practice (see
> [What is not verified yet](#what-is-not-verified-yet)); run it against a
> test tenant before the first real use.

- It **copies**: nothing is deleted or changed in cmail, and nothing is
  deleted, moved or sent in Exchange.
- It copies **each message at most once** per mailbox, even across several
  jobs with overlapping windows.
- By default it copies **received Inbox mail only**. Archive and Sent are
  opt-in. Drafts, Spam and Trash are never copied.
- A manager chooses the **time window** and **one mailbox or all**, runs a
  **dry run** (counts only), then starts the copy. Progress and failures show
  as counts per mailbox: no subjects, senders or content appear in Admin,
  logs or the audit log.

It depends on the [Microsoft 365 mailbox sync](m365-sync.md): the sync's link
table (`m365_sync_links`, migration 0022) maps each cmail mailbox to the
immutable Entra object id of the Exchange mailbox it copies into. Mailboxes
without a link are never copied (the dry run counts them as "not linked").

- Code: `apps/email-worker/src/copy-back/` (`graph.ts` Graph calls, `build.ts`
  message resource, `run.ts` scheduled driver), `packages/shared/src/copy-back.ts`
  (switch, input checks, selection, dry run, progress),
  `apps/web/src/lib/server/copy-back-admin.ts` and
  `apps/web/src/routes/admin/copy-back/` (the Admin page).
- Data: migration `0024_standby_copyback.sql` (`standby_copyback_jobs`,
  `standby_copyback_items`); the switch and last dry run live in `org_settings`.
- Tests: `apps/email-worker/src/copy-back/*.test.ts` (fake Graph and R2 over
  every real migration) and `apps/web/src/lib/server/copy-back-admin.test.ts`.

**In this article**

- [How it works](#how-it-works)
- [Choosing the Graph method](#choosing-the-graph-method)
- [What a copy keeps](#what-a-copy-keeps)
- [Never twice, and safe to stop at any point](#never-twice-and-safe-to-stop-at-any-point)
- [Troubleshoot failures and throttling](#troubleshoot-failures-and-throttling)
- [How to set up copy-back (least privilege)](#how-to-set-up-copy-back-least-privilege)
- [How to run a copy-back](#how-to-run-a-copy-back)
- [Runbook](#runbook)
- [What is not verified yet](#what-is-not-verified-yet)
- [Sources](#sources)

## How it works

```mermaid
flowchart LR
  admin["Admin > Copy back to Exchange<br/>(manager: switch, window, dry run, Start)"] -->|"org_settings, job row"| d1[(D1)]
  cron["Email Worker cron<br/>*/15 * * * *"] --> sw{"Switch on and<br/>a job running?"}
  sw -->|no| stop["Return. No Graph call"]
  sw -->|yes| plan["Plan: queue items<br/>(message id, Entra object id)"]
  plan --> work["Per item: find our marker, find Message-ID,<br/>build, create, restore unread"]
  work -->|"graph.microsoft.com/v1.0 only"| graph["Microsoft Graph<br/>users/{id}/mailFolders/{folder}/messages"]
  work --> d1
  r2[(R2: body and attachments)] --> work
```

1. A manager turns the switch on, enters the window (UTC), scope and folders,
   and presses **Dry run**. The web app counts from D1 only: selected, to copy,
   probably too large, already copied, skipped or failed before, not linked.
   The dry run is stored and audited.
2. **Start copy** is accepted only with the switch on, the Worker's settings
   present, no other job running, the confirmation ticked, and a dry run of
   **exactly the same** window, scope and folders from the last 24 hours.
   Start then counts again and refuses if **the selection itself** has changed
   (every count and the per-mailbox breakdown must match), for example a
   mailbox linked or unlinked since, or mail moved between folders. The
   window must lie in the past.
3. Start freezes the selection (`as_of`): mail and Microsoft 365 links created
   after Start are not part of the job.
4. Every 15 minutes the email Worker takes a lease on the running job, gets
   its token, and queues the job's messages as `pending` items in chunks
   (`INSERT OR IGNORE`; an existing item keeps its state). Then it works due
   items, fewest attempts first, then oldest, bounded per run (5 minutes, 300
   items, 1,200 Graph requests). It re-reads the job status and the switch
   before every item, so **Cancel** and switching off take effect at once.
5. When nothing is left to try, the job is `done`.

### Each message

| Step | Graph call | Why |
|---|---|---|
| a | `GET /users/{id}/messages?$filter=singleValueExtendedProperties/Any(ep: ep/id eq '<marker>' and ep/value eq '<cmail id>')&$select=id&$top=1` | Did an earlier attempt already create it (for example the run was cut off after Exchange accepted it)? Then it is recorded as copied, not created again. The filter covers the whole mailbox, so a copy the user has moved is still found. |
| b | `GET /users/{id}/messages?$filter=internetMessageId eq '<Message-ID>'&$select=id,parentFolderId&$expand=singleValueExtendedProperties($filter=id eq '<marker>')&$top=10` (plus, once per mailbox and run, `GET /users/{id}/mailFolders/sentitems` and `/drafts` for their ids) | Did Exchange receive this message itself (for example some mail still reached it)? Then it is skipped as `already_in_exchange`. Our own copies (they carry the marker) and messages in the user's Sent Items or Drafts do not count: a message someone sent to themselves from Outlook is in their Sent Items but was never delivered to their Inbox. Every other folder counts, so mail an inbox rule moved is still recognised. Not done for Sent items. |
| c | none | Build the message from D1 and R2. Over the size cap: skipped as `too_large`. |
| d | `POST /users/{id}/mailFolders/{inbox\|archive\|sentitems}/messages` | Create the copy. It is **never retried in place**: a 503 or 504 can arrive after Exchange stored the copy, so the item is recorded as an attempt and the next attempt starts with the marker lookup (a). **Draft canary:** unless the answer says `isDraft: false`, the job halts at once (see below). |
| e | `PATCH /users/{id}/messages/{id}` `{ "isRead": false }` | Only when the message was unread in cmail (see below). |

The item is recorded only after the last call succeeds, and step (a) makes
any retry safe.

### Draft canary

The design depends on Exchange storing the copy as a received item, not a
draft. Every create answer, and every copy found by its marker, is checked:
unless Exchange reports `isDraft: false`, that item is recorded as failed
(`created_as_draft`, or `draft_state_unknown` when the answer has no
`isDraft`, which every create example on Microsoft Learn includes: it fails closed), no
retry, the job is set to **halted**, and nothing more is created. A draft is never counted as copied, so a later job that finds it
by its marker halts too instead of treating it as done. To recover: find the
drafts in Outlook by the category "cmail standby copy", remove them (cmail
never deletes anything in Exchange), find the cause (see
[Permissions](#which-permission)), then start a new job.

## Choosing the Graph method

Graph's [Create message](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0)
(`POST /users/{id}/mailFolders/{id}/messages`, application permission
`Mail.ReadWrite`) accepts the body as the JSON
[message resource](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0)
or as base64 MIME (`Content-Type: text/plain`). Either way the documented
result is a **draft**: the examples return `"isDraft": true`, and the MIME
example's `receivedDateTime` is the upload time. Options considered:

| Method | Result | Verdict |
|---|---|---|
| MIME upload | Keeps the original headers, but the item is a draft with today's received time, and the same request cannot set extended properties. Microsoft Q&A threads report no way to make a MIME-created item non-draft afterwards. cmail also does not keep the original MIME. | Rejected |
| JSON resource **with extended properties** | `PidTagMessageFlags` (`Integer 0x0E07`) set on creation, without the "unsent" bit, makes a normal received item; `PidTagMessageDeliveryTime` (`SystemTime 0x0E06`) and `PidTagClientSubmitTime` (`SystemTime 0x0039`) keep the original time. This is the long-standing pattern for uploading mail into an Inbox with Graph (Glen Scales, Exchange MVP). Extended properties can also carry our marker. | **Chosen** |
| Mailbox import/export API (`createImportSession`, GA May 2026) | Faithful, but needs items in FastTransfer stream (FTS) format, which cmail cannot produce from a stored message, uploads to a pre-authenticated `outlook.office365.com` URL, and needs `MailboxItem.ImportExport.All`. | Rejected: wrong format, and the token rule below |
| Upload sessions for attachments over 3 MB | Upload to a pre-authenticated `outlook.office.com` URL. | Not used: messages over the cap are skipped |

The cmail Worker sends its token **only** to
`https://graph.microsoft.com/v1.0/` URLs (the [sync's client](m365-sync.md),
which this feature extends, refuses any other host, and follows no
redirects). Features that hand back a URL on another host are out by design.

### Read and unread

`PidTagMessageFlags` can only be set when the item is created. We create
every copy with `mfRead` (`1`), the value the community pattern documents for
a non-draft item that does not trigger new-mail notifications on phones, and
then, for messages that were unread in cmail, set `isRead: false` with a
normal [Update message](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0)
call. So the unread state uses only documented, updatable properties, and
people do not get a notification storm for old mail.

## What a copy keeps

| Kept | How |
|---|---|
| Received time | `PidTagMessageDeliveryTime` and `PidTagClientSubmitTime` = cmail `received_at` (cmail does not store the original Date header, so sent time = received time) |
| Sender | `from` and `sender` (address and display name) |
| To, Cc, Reply-To | `toRecipients`, `ccRecipients`, `replyTo` |
| Bcc | `bccRecipients`, on **Sent** copies only. cmail stores Bcc only on the sender's own draft and sent copy (migration 0015); received copies never reveal it. |
| Subject, importance | `subject`, `importance` |
| Body | cmail's stored, sanitised HTML body (cmail never keeps the raw original) |
| Attachments, inline images | `fileAttachment` with `contentBytes`; inline parts keep `isInline` and `contentId`, so `cid:` images still show |
| Threading | `internetMessageId`, `In-Reply-To` (`String 0x1042`), `References` (`String 0x1039`) |
| Read/unread | see above |
| Marker | named property `String {8d0b7a4e-3c1f-4b6e-9a52-6f1e2d4c7b90} Name cmailStandbyCopyId` = cmail message id, and category **cmail standby copy** (visible in Outlook) |

**Not kept:** the full original header block (`Received`, authentication
results and so on), because cmail stores parsed fields, not the raw message.
Graph only lets an app add `x-` custom headers on creation, so the original
transport headers could not be recreated anyway.

**Size cap:** the whole create request (JSON with base64 attachments) must be
at most 3 MB, in line with Microsoft's
[attachment guidance](https://learn.microsoft.com/en-us/graph/outlook-large-attachments)
(single POST "under 3 MB"; larger needs an upload session, not used here).
Larger messages are skipped as `too_large`; the dry run shows a first
estimate. The Worker checks the real stored size of the body and of each
attachment before reading it into memory, so nothing over the cap is
buffered. They stay in cmail, where the user can forward them.

**Skipped is final.** Skipped items (`too_large`, `already_in_exchange`,
`body_missing`, `attachment_missing`, `message_gone`, `folder_not_in_scope`)
are not retried by Retry failed: each describes the message, not a passing
fault.

## Never twice, and safe to stop at any point

- `standby_copyback_items` has one row per (cmail message id, Entra object
  id). Triggers in `0024` make a `copied` row final: it cannot go back to
  pending or failed, change its key, be deleted, or be inserted as already
  copied. A later job with an overlapping window finds the row and skips it.
- The marker lookup (step a) covers the gap between Exchange accepting a
  create and cmail recording it: a retry finds the copy and records it instead
  of creating a second one.
- An insert of any kind for a key that is already copied, including
  `INSERT OR REPLACE` (whose implicit delete does not fire delete triggers),
  is dropped by a `BEFORE INSERT` trigger, and no item can ever be re-keyed,
  so `UPDATE OR REPLACE` cannot overwrite a copied row either.
- Ids allow up to 128 characters: cmail message ids are UUIDs (36) or, for
  inbound mail with a Message-ID, `inbound-` plus 64 hex characters (72).
- There is no foreign key to `messages`, so a message deleted in cmail later
  (retention, a manager) neither blocks anything nor erases the record.
- Only idempotent calls (lookups and the unread update) are retried in place
  on a short 429/503/504; the create is not (see step d).
- One job runs at a time (unique index), and a lease (cleared only by the
  invocation that holds it) stops overlapping cron
  invocations from working it twice.

## Troubleshoot failures and throttling

| Answer | What happens |
|---|---|
| Token endpoint refused or throttled | The run stops before any mailbox call; the job waits (`credentials_rejected` an hour, throttling per `Retry-After`). |
| 401 from Graph | The run stops; the job waits an hour (`unauthorized`). |
| 429 on a mailbox | Throttling is per app and mailbox in Outlook ([limits](https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits): 10,000 requests per 10 minutes, 4 concurrent, 150 MB of uploads per 5 minutes). A `Retry-After` up to 5 s is retried in place; longer defers **that mailbox only** to the next run, with no attempt counted. Other mailboxes carry on. |
| 403 on a mailbox | The item fails as `access_denied` (usually: mailbox not in the scoping group, or the role assignment is still in Exchange's cache); the rest of that mailbox waits for the next run. |
| 404 on a mailbox | The item fails as `mailbox_not_found`; the rest of that mailbox waits. A 404 on the unread update right after creating is `copy_not_found` (the new copy itself vanished). |
| 5xx | The item fails as `server_error` (an attempt counted); the rest of that mailbox waits. |
| Network error | The item fails as `network`; three in one run stop the run (the network, not the item). |
| 400, 422 | The item fails as `rejected`. |
| 413 | The item is skipped as `too_large`. |
| cmail could not read the message (D1 or R2 error) | The item fails as `internal` (an attempt counted); the run carries on. |

A failed item is retried after 5, 10, 20, 40 and 80 minutes; after 6 attempts
it stays failed ("gave up") until a manager presses **Retry failed**, which
resets only failed items in that job's selection and, for a finished job,
reopens it in the same transaction (refused while another job runs, and for
a halted or cancelled job). Because items are worked fewest attempts first,
one item that keeps failing never holds up the others.
**Cancel** stops a running job; copies already made stay in Exchange.

## How to set up copy-back (least privilege)

Onboarding a Microsoft 365 organisation end to end? See [the onboarding guide](onboarding-microsoft-365.md#12-standby-test-switch-and-copy-back-optional), step 12.

Do these on a **test tenant first**. Everything below is per instance; cmail's
code has no tenant data.

### 1. A separate Entra app for copy-back

Use a **different** app registration from the Microsoft 365 sync, so the
sync's read-only secret can never write mail.

1. Entra admin center > App registrations > New registration, for example
   "cmail standby copy-back". Single tenant. No redirect URI.
2. Certificates & secrets > New client secret. Note when it expires.
3. **API permissions: do not add `Mail.ReadWrite` here, and do not grant
   admin consent for any mail permission.** An Entra-consented application
   permission applies to every mailbox in the tenant, and Exchange RBAC for
   Applications **adds** to it rather than narrowing it
   ([RBAC for Applications, FAQ](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac#why-does-my-application-still-have-access-to-mailboxes-that-arent-granted-by-the-scope-i-used-in-exchange-online-application-rbac)).
   The mail permission comes only from step 3. (Remove the default delegated
   `User.Read` too if you like; the app never signs a user in.)
4. Enterprise applications > find the app: note its **Application ID** and
   **Object ID** (of the service principal, not the App registrations page).

### 2. A mail-enabled security group

Create a mail-enabled security group (Exchange admin center > Groups, or
`New-DistributionGroup -Type Security`), for example "cmail copy-back
mailboxes", and add the people (and shared mailboxes) whose mail may be
copied: normally the same people as the sync's scope. **Only direct members
count**: nested groups are out of scope for this filter. Get its
distinguished name:

```powershell
Connect-ExchangeOnline
(Get-Group "cmail copy-back mailboxes").DistinguishedName
```

### Which permission

Two Graph application permissions can create mail
([permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)):

- `Mail.ReadWrite`: "Allows the app to create, read, update, and delete mail
  in all mailboxes without a signed-in user."
- `Mail-Advanced.ReadWrite.All`: "Allows the app to create, read, update, and
  delete all email, including contents of non-draft emails in user
  mailboxes". Microsoft added it for the change announced on 26 March 2026:
  **from 31 December 2026**, updating sensitive properties (subject, body,
  recipients and others that the
  [Update message](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0)
  reference marks "updatable only if isDraft = true") of **existing
  non-draft** messages needs one of the Mail-Advanced permissions; drafts and
  management properties such as read state stay with `Mail.ReadWrite`
  ([Microsoft 365 Developer Blog](https://devblogs.microsoft.com/microsoft365dev/graph-api-updates-to-sensitive-email-properties/),
  [Exchange Team Blog](https://techcommunity.microsoft.com/blog/exchange/upcoming-breaking-changes-to-modifying-sensitive-email-properties-via-graph-api/4505227)).
  A Microsoft PM notes in that post's comments that it is a superset of
  `Mail.ReadWrite`.

What copy-back does: it **creates** each message once, with every property
set in that one create call, and afterwards only updates `isRead`, which the
Update message reference lists without the draft restriction. It never
updates the subject, body, recipients or extended properties of an existing
message. So by Microsoft's published rules **`Mail.ReadWrite` is enough**,
and it is what this guide assigns, through the Exchange role
**`Application Mail.ReadWrite`**.

What is unproven, honestly:

- Microsoft's posts describe updates and say nothing about a create that
  sets `PidTagMessageFlags` so the new item is born non-draft. Whether the
  31 December 2026 enforcement treats that as a sensitive change is not
  documented.
- Exchange RBAC for Applications lists a role **`Application
  Mail-Advanced.ReadWrite.All`** ("including contents of non-draft emails"),
  but Microsoft has not said (asked in the blog comments, no answer) whether
  the Mail-Advanced permissions are enforced through RBAC for Applications in
  the same way.

So: test on a test tenant with `Application Mail.ReadWrite` now, and again
**after 31 December 2026**. If creates are then refused (403, or items come
back as drafts and the canary halts the job), assign the role
`Application Mail-Advanced.ReadWrite.All` with the same scope instead (step
3, replace the role name), which is still limited to the group, and test
again. Do not consent either permission in Entra.

### 3. Exchange RBAC for Applications

Microsoft now recommends RBAC for Applications, which "replaces Application
Access Policies"
([Learn](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)).
You need the Organization Management role group in Exchange Online.

```powershell
Connect-ExchangeOnline

# Pointer to the Entra service principal (Enterprise applications IDs).
New-ServicePrincipal -AppId <application-id> -ObjectId <service-principal-object-id> -DisplayName "cmail standby copy-back"

# Scope: direct members of the group from step 2.
New-ManagementScope -Name "cmail copy-back mailboxes" -RecipientRestrictionFilter "MemberOfGroup -eq '<group distinguished name>'"

# Mail.ReadWrite on those mailboxes only. It does not include sending mail.
New-ManagementRoleAssignment -App <service-principal-object-id> -Role "Application Mail.ReadWrite" -CustomResourceScope "cmail copy-back mailboxes"

# Check: InScope True for a member, False for anyone else.
Test-ServicePrincipalAuthorization -Identity <service-principal-object-id> -Resource member@example.com
Test-ServicePrincipalAuthorization -Identity <service-principal-object-id> -Resource notamember@example.com
```

An Entra administrative unit can be used instead of a group
(`-RecipientAdministrativeUnitScope`). Changes take **30 minutes to 2 hours**
to apply, because of Exchange's permission cache; the test cmdlet bypasses the
cache, Graph calls do not.

`Application Mail.ReadWrite` is the least role that can create messages and
set read state. `Mail.ReadBasic` and `Mail.Read` cannot write, and the
full-access roles also send mail. `Application Mail-Advanced.ReadWrite.All`
is the fallback described under [Which permission](#which-permission).

### 4. The email Worker

```sh
# wrangler.toml [vars] (M365_TENANT_ID is shared with the sync)
M365_TENANT_ID = "<directory (tenant) id>"
M365_COPYBACK_CLIENT_ID = "<application (client) id>"

wrangler secret put M365_COPYBACK_CLIENT_SECRET --config apps/email-worker/wrangler.toml
```

The copy runs on the existing `*/15 * * * *` cron (no new trigger). It needs
Workers Paid like the sync (subrequests per invocation).

### 5. Database and switch

Apply migration `0024` (additive: two tables, three indexes including one on
`messages.received_at`, four triggers) with
`pnpm db:migrate` (live databases: the owner's yes first). Then, in
**Admin > Copy back to Exchange**, check that no settings are listed as
missing and turn the switch on.

## How to run a copy-back

1. Make sure the sync has linked the mailboxes (Admin > Microsoft 365 sync).
2. Enter the window in UTC, from when Exchange stopped receiving to when mail
   flowed to Exchange again. Prefer a little too wide: messages Exchange
   already has are skipped by Message-ID.
3. Choose all linked mailboxes or one; keep Inbox; add Archive or Sent only if
   people filed or sent mail in cmail during the outage.
4. **Dry run**, read the counts, tick the confirmation, **Start copy**.
5. Watch Copied rise every 15 minutes. Check the failures table at the end.

A good first test: one test mailbox, a window with a few messages, then check
in Outlook that the copies are in the Inbox, not drafts, at the right time,
with attachments, read state and the "cmail standby copy" category.

## Runbook

| Shows | Meaning | Do |
|---|---|---|
| `not_configured` | Worker settings missing | Set `M365_COPYBACK_CLIENT_ID` and the secret (step 4). |
| `error`, `credentials_rejected` | Wrong or expired client secret | Create a new secret, `wrangler secret put`, wait for the hour's backoff or start again. |
| `error`, `unauthorized` | Token refused by Graph | Check the app and tenant ids. |
| Many `access_denied` | Mailboxes outside the RBAC scope, or the cache has not caught up | Check group membership and `Test-ServicePrincipalAuthorization`; wait up to 2 hours; **Retry failed**. |
| `mailbox_not_found` | No Exchange mailbox for that object | Check the person's license and mailbox; **Retry failed**. |
| `backoff` | Microsoft throttled | Nothing; it resumes. |
| `too_large` | Over 3 MB | The message stays in cmail; the user forwards it. |
| Job `halted`, `created_as_draft` | Exchange stored a copy as a draft | See [Draft canary](#draft-canary) and [Which permission](#which-permission). |
| `server_error`, `network`, `internal` | A passing fault on one item | Nothing: it is retried with backoff; Retry failed after it gives up. |
| `body_missing`, `attachment_missing` | The R2 object is gone | Check backups; the message is otherwise readable in cmail. |

To undo copies in Exchange, search by the category "cmail standby copy" in
Outlook, or by the marker property with Graph. cmail never deletes them.

## What is not verified yet

- End to end against a real tenant: not done.
- That `PidTagMessageFlags = 1` on create gives `isDraft: false` comes from
  community practice (Glen Scales), not Microsoft's reference pages; the
  reference only says creates make drafts by default. The draft canary
  stops a job at the first copy where this does not hold.
- Whether `Mail.ReadWrite` still allows that create after the 31 December 2026
  enforcement, and whether `Application Mail-Advanced.ReadWrite.All` works
  through RBAC for Applications (see [Which permission](#which-permission)).
- That `internetMessageId`, `In-Reply-To` and `References` are accepted on
  create, and threading follows, is not documented for app-created items.
- That an Entra app with **no** consented mail permission gets a usable token
  for Graph mail calls through RBAC for Applications follows Microsoft's
  guidance (the role assignment replaces the Entra grant) but has not been
  observed here.
- The exact Graph request size limit for one create call: the 3 MB cap
  follows the attachment guidance.

## Sources

- Microsoft Learn: [Create message](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0),
  [Create message in a mailFolder](https://learn.microsoft.com/en-us/graph/api/mailfolder-post-messages?view=graph-rest-1.0),
  [message resource](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0),
  [Get extended properties (filter)](https://learn.microsoft.com/en-us/graph/api/singlevaluelegacyextendedproperty-get?view=graph-rest-1.0),
  [Attach large files](https://learn.microsoft.com/en-us/graph/outlook-large-attachments),
  [Import a mailbox item](https://learn.microsoft.com/en-us/graph/import-exchange-mailbox-item),
  [Throttling limits: Outlook](https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits),
  [RBAC for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac).
- Microsoft Q&A: [create a non-draft message from MIME](https://learn.microsoft.com/en-gb/answers/questions/2106197/microsoft-graph-api%29is-any-option-create-message-f).
- Microsoft: [Graph API updates to sensitive email properties](https://devblogs.microsoft.com/microsoft365dev/graph-api-updates-to-sensitive-email-properties/) (26 March 2026) and the [Exchange Team Blog post](https://techcommunity.microsoft.com/blog/exchange/upcoming-breaking-changes-to-modifying-sensitive-email-properties-via-graph-api/4505227); [Update message](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0); [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference).
- Glen Scales: [How to upload an email using the Microsoft Graph API into the Inbox](https://dev.to/gscales/how-to-upload-an-email-using-the-microsoft-graph-api-into-the-inbox-36o8).
- Cloudflare: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (Cron Triggers: 15 minutes wall time per invocation).
