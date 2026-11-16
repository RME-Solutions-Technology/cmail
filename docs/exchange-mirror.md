---
title: "Exchange mirror (warm standby of Exchange Online)"
summary: "How to keep cmail a live copy of every Exchange Online mailbox, from Microsoft Graph (recommended) or a journal rule, with no setup per address."
applies_to: standby
audience: [operator, manager]
switch: "Admin > Exchange mirror"
last_reviewed: 2026-11-16
related: [onboarding-microsoft-365.md, credentials.md, standby-switch.md, multi-domain.md]
---

# Exchange mirror (warm standby of Exchange Online)

Two sources feed the mirror. The **[Graph source](#graph-source-recommended)
(recommended)** reads each mailbox from Microsoft 365 with Microsoft Graph.
The **journal source** receives Exchange journal reports by email; with
Cloudflare Email Routing it loses mail from senders whose DMARC policy is
`p=reject` ([why](#why-not-journaling-over-cloudflare-email-routing)), so it
is not recommended there.

Journal source status: **built, off by default, running on one Microsoft 365 tenant
since 16 November 2026.** Live journal reports from that tenant pass the
checks in [How a report is trusted](#how-a-report-is-trusted) and are filed.
What a live report carries is in
[What Exchange Online actually stamps](#what-exchange-online-actually-stamps);
what is still unproven is in [What is not verified](#what-is-not-verified).
The code paths are covered by tests (see [How to test](#how-to-test)).

cmail's main use is primary email for your organisation. This feature is
for the other case: an organisation that stays on Exchange Online and wants
cmail as a live copy ("warm standby") of every mailbox, so that if Exchange
fails, people already have their recent mail in cmail. It needs **no setup
per address**. The Graph source needs one Exchange role assignment and one
cmail switch; the journal source one Exchange journal rule, one Cloudflare
Email Routing rule and two cmail switches. Both cover a tenant of any size
(built for 200+ seats and 500+ addresses).

> **If Exchange is down, switch as soon as you can:** until you switch, new
> mail is not received here either (the mirror reads from Microsoft 365).
> Mail sent to you during an Exchange outage is held and retried by the
> sender's server for a few days, so it arrives once the switch is done.
> See [Switch mail to the cmail standby](standby-switch.md).

The diagram shows the journal source; the Graph source has
[its own](#how-it-works).

```
 Exchange Online                     Cloudflare Email Routing       cmail email Worker
 ───────────────                     ────────────────────────       ──────────────────────────────────
 journal rule: all messages  ──►     journal-<token>@<domain>  ──►  exact address? switch on?
 (envelope journaling: one           one literal rule → Worker      trusted report? (header, tenant,
  report per message, original                                       DMARC/DKIM)
  attached unaltered)                                                parse envelope recipients
                                                                     map to mailboxes (address or alias)
                                                                     file the ORIGINAL into each, once
                                                                     sender's copy into Sent
```

**In this article**

- [Graph source (recommended)](#graph-source-recommended)
  - [Why not journaling over Cloudflare Email Routing](#why-not-journaling-over-cloudflare-email-routing)
  - [Permission: Mail.Read, scoped with RBAC for Applications](#permission-mailread-scoped-with-rbac-for-applications)
  - [How to set up the Graph source](#how-to-set-up-the-graph-source)
- [Journal source (not recommended with Cloudflare Email Routing)](#journal-source-not-recommended-with-cloudflare-email-routing)
- [Why journaling](#why-journaling)
- [What is and is not mirrored](#what-is-and-is-not-mirrored)
- [How a report is trusted](#how-a-report-is-trusted)
- [How mail is filed](#how-mail-is-filed)
- [Aliases](#aliases)
- [How to set up the Exchange mirror](#how-to-set-up-the-exchange-mirror)
- [Admin](#admin)
- [Size limits](#size-limits)
- [Privacy](#privacy)
- [How to turn it off and roll back](#how-to-turn-it-off-and-roll-back)
- [What is not verified](#what-is-not-verified)
- [How to test](#how-to-test)

## Graph source (recommended)

Status: **built, off by default, not yet run on a live tenant.** The code
paths are covered by tests against a fake Microsoft Graph (see
[How to test](#how-to-test)).

> **If Exchange is down, switch as soon as you can:** until you switch, new
> mail is not received here either (the mirror reads from Microsoft 365).
> Mail sent to you during an Exchange outage is held and retried by the
> sender's server for a few days, so it arrives once the switch is done.
> See [Switch mail to the cmail standby](standby-switch.md).

### Why not journaling over Cloudflare Email Routing

A journal report carries the **original** sender in its From (seen live, see
[What Exchange Online actually stamps](#what-exchange-online-actually-stamps)).
Cloudflare Email Routing checks DMARC for the From domain of every message it
receives and refuses mail whose domain publishes `p=reject` and fails
([postmaster](https://developers.cloudflare.com/email-service/reference/postmaster/#mail-authentication-requirement));
this is not configurable. A journal report is sent by Exchange, not by the
original sender, so it always fails that sender's DMARC. Every message from a
sender with `p=reject` (large mail providers, social networks, banks, many
ISPs) is therefore refused before cmail sees it, and the refusals show up in
those senders' DMARC aggregate reports. In practice that is a large share of
inbound mail. The journal source stays in cmail for other routes, but is
**not recommended with Cloudflare Email Routing**.

### How it works

```
 Microsoft 365 (Exchange Online)          cmail email Worker (cron, every 5 minutes)
 ───────────────────────────────          ─────────────────────────────────────────────
 each linked mailbox:                ◄──  switch on? lease, round robin over mailboxes
   Inbox, Sent Items, Archive             GET .../mailFolders/{folder}/messages/delta
   (Graph delta query, app-only)          already here (Message-ID)? count, no download
                                    ◄──   GET .../messages/{id}/$value (MIME)
                                          file through the mirror's own filing code
```

- **Which mailboxes:** every active cmail mailbox the
  [Microsoft 365 sync](m365-sync.md) linked to a Microsoft 365 object: each
  person's own mailbox and each linked shared mailbox, on any of the
  organisation's domains ([Multiple mail domains](multi-domain.md)). Nothing
  to set up per address.
- **Which folders:** the well-known folders `inbox`, `sentitems` and
  `archive` (`M365_GRAPH_MIRROR_ARCHIVE = "false"` leaves Archive out).
  Inbox copies go to Inbox, Archive copies to Archive, Sent Items copies to
  Sent (with the Bcc list, which only the sender's copy shows). Mail a rule
  moved into another folder before the mirror read it is not mirrored.
- **What is new:** a Graph delta query per mailbox and folder
  ([message: delta](https://learn.microsoft.com/en-us/graph/api/message-delta)),
  asking only for `internetMessageId`, `receivedDateTime` and `isDraft`, 50 per
  page. The next or delta link is stored per mailbox and folder
  (`graph_mirror_folders`, migration `0033`). Drafts, `@removed` entries and
  change events for mail older than the round (Graph also reports read-state
  changes) are never filed.
- **Exactly once:** before anything is downloaded, the Message-ID is looked
  up in the mailbox. An Inbox copy has the same id the normal inbound path
  and the journal source give it (mailbox + Message-ID), and a Sent copy the
  same id as the journal source's Sent copy; a Sent copy is also skipped when
  the mailbox already has a Sent message with that Message-ID (mail cmail sent
  itself, or [copied back](copy-back.md) into Exchange). So the Graph and
  journal sources can be on together during a change-over: each message is
  filed once, and a replayed delta page files nothing new.
- **Filing:** the MIME (`GET /users/{id}/messages/{id}/$value`) goes through
  the same code as a journal report's original: the same HTML sanitizer,
  body, attachment, blocked-type and size limits, storage quota, an
  organisation-wide sender block rule (to Spam), no inbox rules, no
  forwarding, no auto-reply, no notification, filed **as read** with the time
  Exchange received it. It is
  trusted as coming from the tenant (read with the app's own token), so no
  SMTP authentication headers are checked.
- **Colleagues and Focused Inbox:** mail a user of this tenant sent carries
  Exchange's `X-MS-Exchange-CrossTenant-AuthAs: Internal` and this tenant's
  id, as on the journal path, so Focused Inbox treats the sender as a
  colleague. Internet mail does not. cmail's own colleague mail sent through
  Exchange is matched as on the journal path
  ([Mail sent from cmail to colleagues](#mail-sent-from-cmail-to-colleagues)).
- **First pull and cap:** a folder seen for the first time is read from now
  minus `M365_GRAPH_MIRROR_LOOKBACK_HOURS` (default 24), newest first, using
  the one filter and the one order message delta supports
  (`receivedDateTime ge`, `receivedDateTime desc`), and files at most
  `M365_GRAPH_MIRROR_INITIAL_CAP` messages (default 500); older ones are
  counted as "left out", never filed silently. **Import older mail** in Admin
  (1 to 90 days) starts every folder again from that far back, with a cap of
  20,000 per folder; mail already filed is not filed twice.
- **Expired token (410):** the folder starts again from the newest message of
  its last finished round, less one hour (a folder still paging starts again
  from its round's own start), never from the beginning. No cap applies to
  this catch-up; mail already filed is counted, not downloaded again. A
  message moved into Archive during the gap with an older received time is
  not picked up.
- **Throttling:** 429, 503 and 504 honour `Retry-After` (in place when 5
  seconds or less; otherwise that mailbox waits and the others go on;
  [throttling](https://learn.microsoft.com/en-us/graph/throttling)). A message
  that could not be read or stored, or that the run's budget could not cover,
  keeps its page, which is read again next time.
- **Refused mailboxes:** a 403 (outside the RBAC scope below, or no
  permission) is retried hourly and counted in Admin; when every mailbox is
  refused, Admin says the permission is missing.
- **Bounded work:** each run stops starting new work after 60 seconds, 400
  Graph requests or 5,000 subrequests in all, reads at most 4 pages per folder
  per visit, and works the mailboxes round robin from where the last run
  stopped, so every mailbox is reached however large the tenant
  ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)).
  A lease on `graph_mirror_state` keeps two runs apart. It runs on the
  `*/5 * * * *` cron, and on `*/10 * * * *` too for an instance whose
  wrangler file does not have the new cron yet.

What it does not do: it never writes, moves, deletes or sends anything in
Microsoft 365, and it does not mirror read state, flags, moves or deletions
made in Outlook after a message was filed.

### Permission: Mail.Read, scoped with RBAC for Applications

The Graph source uses the **Microsoft 365 sync app** (the same
`M365_TENANT_ID`, `M365_CLIENT_ID` and `M365_CLIENT_SECRET`;
[credentials](credentials.md#microsoft-365-sync-app)). It needs to read mail,
which is `Mail.Read` (`Mail.ReadBasic.All` cannot read the message body or
MIME). Grant it **in Exchange Online, scoped to the mirrored mailboxes**, with
[RBAC for Applications](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac),
which Microsoft says "replaces Application Access Policies":

- **Do not** add `Mail.Read` as an Entra (Microsoft Graph) application
  permission with admin consent. Entra and Exchange grants add up: an Entra
  `Mail.Read` covers every mailbox in the tenant, so a scope in Exchange would
  then have "no effective resource scoping" (Microsoft's FAQ on the same page).
- Needs Exchange **Organization Management** (Exchange Administrator has it).
- Changes take 30 minutes to 2 hours to apply (Exchange's cache);
  `Test-ServicePrincipalAuthorization` shows the result at once.

With Exchange Online PowerShell (`Connect-ExchangeOnline`), using the sync
app's IDs from **Entra > Enterprise applications** (not App registrations):

```powershell
# Pointer to the sync app's service principal.
New-ServicePrincipal -AppId <sync-app-application-id> -ObjectId <sync-app-service-principal-object-id> -DisplayName "cmail Microsoft 365 sync"

# Scope, option A (recommended; the setup in use on a live tenant): every user and shared mailbox, rooms and equipment left out.
New-ManagementScope -Name "cmail mirror mailboxes" -RecipientRestrictionFilter "RecipientTypeDetails -eq 'UserMailbox' -or RecipientTypeDetails -eq 'SharedMailbox'"

# Scope, option B: direct members of one mail-enabled group (nested groups do not count).
# New-ManagementScope -Name "cmail mirror mailboxes" -RecipientRestrictionFilter "MemberOfGroup -eq '<group distinguished name>'"

# Mail.Read on those mailboxes only. Read only: no write, no send.
New-ManagementRoleAssignment -App <sync-app-service-principal-object-id> -Role "Application Mail.Read" -CustomResourceScope "cmail mirror mailboxes"

# Check: InScope True for a mirrored mailbox, False for one outside the scope.
Test-ServicePrincipalAuthorization -Identity <sync-app-service-principal-object-id> -Resource person@example.com
Test-ServicePrincipalAuthorization -Identity <sync-app-service-principal-object-id> -Resource room@example.com
```

The token is the normal client-credentials token (`https://graph.microsoft.com/.default`); with no Entra `Mail.Read` it carries no mail permission itself, and Exchange applies the role per mailbox: in-scope mailboxes are read, any other answers 403 and is shown in Admin as outside the scope, without stopping the run for the rest.

`New-ServicePrincipal` is needed once per app; if the sync app already has a
pointer (for example for `Application MailboxSettings.Read`), skip it. The
group's distinguished name comes from `Get-Group "<group name>" | Select-Object DistinguishedName`.

To remove it later:
`Remove-ManagementRoleAssignment -Identity "<assignment name from Get-ManagementRoleAssignment -RoleAssignee <object id>>"`.

### How to set up the Graph source

Every step that changes a live system needs the owner's yes.

1. The [Microsoft 365 sync](m365-sync.md) is on and out of dry run, so
   mailboxes are linked.
2. Apply migration `0033` (`pnpm db:migrate`). It adds two tables and changes
   no existing row.
3. Assign `Application Mail.Read` with the commands above, and check with
   `Test-ServicePrincipalAuthorization`.
4. Optional Worker vars (defaults shown): `M365_GRAPH_MIRROR_LOOKBACK_HOURS =
   "24"`, `M365_GRAPH_MIRROR_INITIAL_CAP = "500"`,
   `M365_GRAPH_MIRROR_ARCHIVE = "true"`. Add `"*/5 * * * *"` to the email
   Worker's `[triggers] crons` (without it the source runs every 10 minutes).
   Deploy the email Worker and web app.
5. Admin > Exchange mirror > **Turn Graph source on**, then **Run now**.
   Within a few minutes Admin shows the mailboxes covered and the messages
   filed. "Permission missing" means step 3 has not reached Exchange's cache
   yet (up to 2 hours) or was not done.
6. If the journal source was in use: leave both on for a day (each message is
   filed once), then disable the journal rule
   (`Disable-JournalRule -Identity "cmail mirror"`) and turn the journal
   source off.

To turn it off: Admin > Exchange mirror > **Turn Graph source off**. Nothing
more is read; mail already filed stays. Remove the role assignment if it is
not coming back. Migration `0033` is additive; leaving it applied is
harmless.

### Admin

Admin > Exchange mirror, **Graph source (recommended)** (managers only): the
switch (audited, `org.graph_mirror_toggled`), **Run now** (one bounded run,
audited), **Import older mail** (audited), the settings the Worker reports,
and the status: last run, last clean run, mailboxes covered, filed today (to
Inbox or Archive, and to Sent), already here, skipped and left out, the last
error code in plain words, mailboxes refused, and "permission missing". It
holds counts and codes only; the mail trace has one line per filed copy, as
for any delivery. Skipped copies are audited
(`graph_mirror.copies_skipped`, counts and the first reason, at most one row
per run).

## Journal source (not recommended with Cloudflare Email Routing)

Everything from here to [How to test](#how-to-test) describes the journal
source. With Cloudflare Email Routing it loses mail from every sender whose
DMARC policy is `p=reject` ([why](#why-not-journaling-over-cloudflare-email-routing));
use the [Graph source](#graph-source-recommended) instead.

## Why journaling

Exchange Online journaling is the standard, supported way to give a system
outside Exchange a copy of every message:

- Journal reports can only go **outside** Exchange Online: "Exchange Online
  doesn't support delivering journal reports to an Exchange Online mailbox.
  You must specify the email address of an on-premises archiving system or a
  third-party archiving service"
  ([Configure journaling](https://learn.microsoft.com/en-us/exchange/security-and-compliance/journaling/configure-journaling)).
- **Licence:** journaling is available in every Exchange Online plan
  (Exchange Online Plan 1 and 2, Kiosk, Microsoft 365 Business Basic,
  Standard and Premium, E3, E5, F3), with no extra per-user licence found
  ([service description](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-service-description)).
- **Limits:** 300 journal rules in Microsoft 365 Business and Enterprise
  plans, 50 in standalone Exchange Online plans
  ([Exchange Online limits](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits#journal-transport-and-inbox-rule-limits)).
  This feature needs **one**.
- **Scope:** a rule with no recipient journals "all messages sent to or from
  recipients that match the journal rule scope", and the scope can be all
  messages, internal only or external only
  ([Journaling](https://learn.microsoft.com/en-us/exchange/security-and-compliance/journaling/journaling)).
- **Format:** envelope journaling is "the only journaling method supported by
  Microsoft 365 and Office 365". The original message "is included unaltered
  as an attachment", and the report body lists the sender, subject,
  Message-ID and every recipient, including Bcc and the members of expanded
  distribution groups ([Journaling](https://learn.microsoft.com/en-us/exchange/security-and-compliance/journaling/journaling);
  field-level format: [journal report fields](https://learn.microsoft.com/en-us/previous-versions/office/exchange-server-2007/bb331962(v=exchg.80))).

Alternatives Microsoft offers, and why they were not used:

| Option | Why not |
|---|---|
| Mail flow rule "Bcc the message to" | In Exchange Online it cannot target a distribution group ([mail flow rule actions](https://learn.microsoft.com/en-us/exchange/security-and-compliance/mail-flow-rules/mail-flow-rule-actions)). The copy is a normal outbound message with the headers of a delivery, not an envelope: it does not say who got the message by Bcc or through a group, so cmail could not file it per recipient. It also goes through outbound spam policy and sending limits like any mail. |
| Forwarding per mailbox | Setup per address (the opposite of the goal), and automatic external forwarding is blocked by Exchange Online's default outbound spam policy. |
| Microsoft 365 retention (Purview) | Keeps data inside Microsoft 365. Microsoft recommends it where possible ([Journaling](https://learn.microsoft.com/en-us/exchange/security-and-compliance/journaling/journaling)), but it does not help when Exchange Online itself is down. |
| Graph mailbox copy (cmail's copy-back in reverse) | Needs `Mail.Read` on every mailbox, polling per mailbox and much more API traffic; journaling pushes each message once. **Since built as the [Graph source](#graph-source-recommended)**, because journal reports over Cloudflare Email Routing lose mail from `p=reject` senders. |

Microsoft calls journaling "an older feature from Exchange". It is still
documented and supported for exactly this use: a copy outside Exchange.

## What is and is not mirrored

Mirrored, for every mailbox cmail knows (by primary address or imported
alias):

- Mail received from the internet and from inside the organisation, into
  each recipient's Inbox. Bcc recipients and members of expanded
  distribution groups get their copy.
- Mail to shared mailboxes that cmail has (for example from the Microsoft
  365 sync), as for people.
- Optionally (off by default), the sender's copy into the sender's **Sent**
  folder, when the sender is a cmail user who sent through Exchange (see
  [How mail is filed](#how-mail-is-filed)).

Not mirrored:

- Mail Exchange did not deliver (quarantined mail is journaled only after it
  is released, per Microsoft).
- Folders, read state, flags, deletions and moves people make in Outlook:
  a journal report is sent once, when the message passes through Exchange.
  Mirrored copies are filed as **read**, so a switch to cmail does not show
  months of mail as unread.
- Calendar items as calendar entries (an invitation is filed as a message
  only), contacts and drafts.
- Recipients with no active cmail mailbox: they are counted as "unmatched"
  and ignored. So is a mailbox left on a domain that is no longer one of the
  organisation's domains ([Multiple mail domains](multi-domain.md)); the
  day's latest problem then reads `unmatched_domain`.
- Exchange's own spam verdict. A cmail organisation-wide sender **block**
  rule still files the copy to Spam, as on the normal path.
- Messages larger than the limits in [Size limits](#size-limits).
- Mail sent with encryption from outside the organisation stays encrypted.
  For the organisation's own Microsoft Purview Message Encryption, turn on
  journal report decryption (`Set-IRMConfiguration -JournalReportDecryptionEnabled $true`,
  [Journaling](https://learn.microsoft.com/en-us/exchange/security-and-compliance/journaling/journaling)).

Nothing a mirrored copy does can send mail: no inbox rules run on it, no
forwarding, no auto-reply, no bounce, no read receipt, and no new-mail
notification (people are still reading in Outlook), except for cmail's own
colleague mail coming back through Exchange
([below](#mail-sent-from-cmail-to-colleagues)). The only SMTP answer
cmail ever gives is Cloudflare's own refusal of a report that fails the
checks below.

### Mail sent from cmail to colleagues

By default, mail from cmail to a colleague who also has a cmail mailbox is
filed straight into that mailbox, as on any instance. While Exchange holds
the organisation's mail domains ([Multiple mail domains](multi-domain.md)),
that copy never reaches Exchange, so the colleague does not see it in Outlook.

**Send colleague mail through Exchange** (Admin > Exchange mirror, **off by
default**, acts only while the mirror is on) changes that: recipients on any
of the organisation's mail domains are sent through the outbound provider like any external
address. Exchange delivers the message to Outlook, the journal report comes
back, and the mirror files the cmail copy once (the copy's id comes from the
Message-ID, so a repeated report or a second delivery path files nothing
new). The sender's own Sent copy is stored by cmail as usual; the mirror adds
no second one, because a message from the provider reaches Exchange as
internet mail and so never carries the internal-submission proof a mirrored
Sent copy needs.

When the colleague's copy matches a message this instance sent, the mirror
treats it as proven internal mail: it is filed **unread** with a new-mail
notification, and Focused Inbox treats the sender as a colleague. It matches
when the sender's Sent copy in cmail, from the last 2 days, has the same
Message-ID (as the provider reported it: the Cloudflare REST route and
Postmark do), the same subject, and the colleague in To or Cc, and Exchange
did not record a DMARC or composite-authentication failure on it. Anything
else (a Bcc'd colleague, a provider that does not report the Message-ID, an
older or altered message) is filed like any mirrored copy, as read with no
notification. A forged copy would need the Message-ID and subject and to
reach the journal before the real one, which arrives within minutes. cmail
inbox rules never run on mirrored copies.

With the switch on:

- A send to a colleague needs the outbound provider ([Sending](sending.md));
  without it the send is refused with the provider's setup message.
- A colleague in **Bcc** is an envelope-only recipient, so the provider must
  be able to split the envelope (the Cloudflare REST route); on a provider
  that cannot, the send is refused before anything leaves.
- "Sent" means the provider accepted it. If Exchange later refuses it, the
  bounce arrives afterwards, as for any external recipient
  ([delivery status](delivery-and-bounces.md)).
- If the switches cannot be read, the send fails and the draft is kept.
- After a [standby switch-over](standby-switch.md) (MX at Cloudflare), turn
  it and the mirror off (the switch-over runbook says when).

#### Exchange settings to check first

Mail from your own domain arriving from Cloudflare is, to Exchange, internet
mail claiming to be from inside. Check, with Exchange Online PowerShell:

| Check | Command | What you want |
|---|---|---|
| Reject Direct Send | `Get-OrganizationConfig \| Format-List RejectDirectSend` | `False`. When `True`, Exchange rejects unauthenticated mail from your own domain to your MX unless a partner connector covers the sender; such a connector for Cloudflare Email Sending is not documented. Leave the switch off. |
| Sender authentication | a test message's `Authentication-Results` header | `spf=pass`, `dkim=pass` with `header.d=` your domain, `dmarc=pass`, `compauth=pass`. Needs the domain onboarded to Cloudflare Email Sending. |
| Spoof and impersonation policies | Microsoft Defender > Anti-phishing, Tenant Allow/Block List > Spoofed senders | The test message is not quarantined or sent to Junk. |
| External sender tags | `Get-ExternalInOutlook`; mail flow rules that add `[EXTERNAL]` | Decide whether an "External" tag on colleague mail is acceptable. |

#### Prove it with one message

Before relying on it, on the live tenant:

1. Turn **Send colleague mail through Exchange** on.
2. From cmail, send one message from a cmail user to one colleague on the
   mail domain (both with Exchange mailboxes).
3. In the colleague's Outlook: it arrives in the Inbox (not Junk or
   quarantine) within a few minutes, and shows as you expect (sender name,
   any External tag). Open the message headers and check the
   authentication results above.
4. In cmail: Admin > Mail trace shows it accepted by the provider and no
   bounce within an hour; Admin > Exchange mirror counts one more filed copy
   and no duplicate in the colleague's cmail Inbox.
5. If any step fails, turn the switch off. Nothing else changes.
## How a report is trusted

A message is treated as a journal report only when **all** of these hold.
Anything else is refused at SMTP with a permanent error (Exchange then sends
it to the "undeliverable journal reports" address), counted, written to the
audit log (`exchange_mirror.report_rejected`, with a reason code and the
envelope sender's domain only; at most 50 audit rows and 200 mail trace rows
a day, the daily count is always exact). It never reaches a mailbox.

> **Do not let the journal address fail temporarily for long.** If the
> address does not accept mail at all (routing rule missing, Worker down or
> answering with a temporary 4xx error), Exchange keeps the reports queued
> and retries. Microsoft says it will contact you and, "If you haven't
> resolved the issue after two days of being contacted, Microsoft will
> disable the problematic journaling rule"
> ([Configure journaling](https://learn.microsoft.com/en-us/exchange/security-and-compliance/journaling/configure-journaling)).
> Watch the "Last journal report" time in Admin.

> **The token is the security boundary.** Only the random token in the
> journal address keeps strangers out. Every other check below raises the bar
> for someone who has the address, but none proves on its own that a report
> came from your tenant: the journal and tenant headers can be written by
> any sender, and the SPF and DKIM checks have the limits stated below. Keep
> the address secret and [rotate the token](#how-to-rotate-the-journal-token) if
> it may have leaked.

0. **Size first.** Before anything is read, the report must be no larger
   than `MAX_INBOUND_BYTES` plus 1 MiB of envelope room (and at most
   Cloudflare's 25 MiB). Larger reports are refused (`too_large`) unread.
1. **The exact journal address.** It arrived at `M365_JOURNAL_ADDRESS`,
   whose local part is `journal-` followed by a random token of 32 to 64
   lower-case letters and digits. Only Exchange and the cmail settings know
   it. Generate the token with `openssl rand -hex 16` (32 characters).
2. **The manager switch is on** (Admin > Exchange mirror). Off: the address
   is treated like any unknown address (refused), nothing is parsed.
3. **It is a journal report:** it carries the `X-MS-Journal-Report` header
   that Exchange adds to every journal report. Any sender can add it too.
4. **Our tenant:** only the OUTER report's own headers are read, never the
   attached original's. The `X-MS-Exchange-CrossTenant-Id` header is
   **optional** on the outer report: live reports sometimes carry none, and
   then this check does not refuse. When it is present, it must include your
   `M365_TENANT_ID`; a report can carry several (seen live: the original
   sender's tenant for mail from another Microsoft 365 organisation, and
   yours). A report whose tenant headers are all other tenants' is refused
   (`wrong_tenant`). Microsoft
   does not document which tenant headers Exchange Online stamps on an
   outbound journal report; `X-MS-Exchange-Organization-*` headers are
   removed by the header firewall when a message leaves an Exchange
   organization ([header firewall](https://learn.microsoft.com/en-us/exchange/header-firewall-exchange-2013-help)),
   so they are not used.
   **This header is attacker-settable:** anyone sending to the journal
   address can write your tenant id into it. It catches honest mistakes
   (another tenant's journal rule pointed here), not attacks.
5. **Authenticated as the tenant** (unless `M365_JOURNAL_REQUIRE_AUTH =
   "false"`): Cloudflare Email Routing's own `Authentication-Results` record
   (the first one, whose identifier is `INBOUND_AUTHSERV_ID`, normally
   `mx.cloudflare.net`;
   [Cloudflare](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/#authentication-results))
   shows either:
   - **a.** a **DKIM pass** whose signing domain (`header.d`) is in
     `M365_JOURNAL_SENDER_DOMAINS`, whatever the From says. Set it to exactly
     the domain(s) the diagnostic shows real journal reports are signed with
     (for example `<tenant>.onmicrosoft.com`), and nothing else. **Replay
     limit:** a DKIM pass proves the domain signed *some* message, not this
     report; anyone with the token can resend any message that domain signed
     (a newsletter, a reply) to the journal address. **Do not leave the
     default (`MAIL_DOMAIN`)** once you know what reports carry: cmail's own
     Cloudflare Email Sending also signs as `MAIL_DOMAIN`, so every message
     cmail sends would pass. Or
   - **b.** an **SPF pass** that Cloudflare's record says was checked for the
     envelope MAIL FROM (`smtp.mailfrom`; the SMTP envelope must agree; no
     fallback to the envelope alone) whose domain is `M365_JOURNAL_NDR_DOMAIN`,
     **and** `X-MS-Exchange-CrossTenant-AuthAs: Internal` on the outer report
     (every instance, at least one; seen on every live report), with check 4
     passed. This is only as strong as Exchange Online's enforcement that no
     other tenant can send with a MAIL FROM on your NDR domain, which
     Microsoft does not document (**unverified**): its sending servers are
     shared by every tenant, and the AuthAs and tenant id headers can be
     forged. Use a dedicated domain for the
     undeliverable-reports address, see `M365_JOURNAL_NDR_DOMAIN` in Setup.

   **DMARC on the From is not used.** A live journal report's From is the
   ORIGINAL message's sender, who is often outside the tenant, so DMARC on it
   says nothing about who sent the report. Domains match only whole
   (`example.com_.evil.example` is not `example.com`). The record is read with
   an RFC 8601 tokenizer: a quoted value is one value, so text inside it
   (`smtp.mailfrom="x dmarc=pass"`, `reason="k header.d=tenant"`) can never
   count as a verdict or a domain. Records added further out are never read.
6. **A safe envelope:** a plain-text envelope (an HTML-only report is
   refused), exactly one attached original (`message/rfc822`), recipient
   lines only after the envelope's single Message-Id line (the Subject line
   above it carries the sender's own text), at most 5,000 recipients.
7. **The envelope describes this original:** the envelope's Message-Id
   equals the attached original's one Message-ID header
   (`message_id_mismatch` otherwise, also when the original has none).

## How mail is filed

- The **original** message is filed, never the report. It goes through the
  same content handling as normal inbound mail: the HTML sanitizer, decoded
  body limit, attachment count and size limits, blocked attachment types,
  link checks when it is read, and the mailbox storage quota. Mirrored
  copies reserve storage as their own kind of reservation, which the hourly
  inbound limits (`INBOUND_MAILBOX_MESSAGES_PER_HOUR` and the others) never
  count: mirroring cannot use up a mailbox's normal inbound allowance, and
  those limits do not apply to mirrored copies. Copies that
  fail one of these are not filed ("skipped", audited as
  `exchange_mirror.copies_skipped`); the report is still accepted, because
  Exchange has already delivered the message.
- Each recipient line (`To`, `Cc`, `Bcc`, `Recipient`, any case, quoted
  display names allowed; `Expanded:` and `Forwarded:` annotations are read
  and the line's own address is the mailbox that got the message) is mapped
  to an active cmail mailbox by primary address, then by imported alias
  (only while the alias import is on and fresh, see [Aliases](#aliases)).
  Each mailbox gets the message once, even if it appears on several lines or
  through several addresses.
- **Exactly once:** a recipient's copy has the same id as the normal inbound
  path would give it (mailbox + Message-ID), so a repeated report, a report
  Exchange split into two, and mail that also arrived directly after a
  switch are all filed once ("duplicates"). Microsoft documents that
  duplicate journal reports happen "by design" when a message is split
  ([Journaling](https://learn.microsoft.com/en-us/exchange/security-and-compliance/journaling/journaling)).
- **Sent copies (off by default).** With `M365_JOURNAL_MIRROR_SENT =
  "true"` (which needs `M365_TENANT_ID`), a copy goes into the sender's Sent
  folder (as read, with the Bcc list from the envelope, which only the
  sender's copy shows) only when **all** hold: the envelope sender is a cmail
  mailbox; Exchange knew the addressing (`To`/`Cc`/`Bcc` lines, which
  Exchange writes for authenticated submissions; internet mail gets
  `Recipient` lines); the sender is the original's From or Sender; and the
  original carries `X-MS-Exchange-CrossTenant-AuthAs: Internal` and
  `X-MS-Exchange-CrossTenant-Id` equal to `M365_TENANT_ID`, at least once
  each and on every instance, and the original's header block is well
  formed (a line without a colon, which the parser would silently drop, could
  hide a header). Anything missing or malformed means no Sent copy (fail
  closed). So a forged From from the internet never lands in anyone's Sent
  folder. Why mirror Sent at all: after a switch, people need their recent
  sent mail to follow up and to keep reply threads together. It stays off
  until the first live test shows real originals carry those headers.
- Mail between two cmail users gives both copies: Inbox for the recipient,
  Sent for the sender.
- Each copy is stored separately (its own body and attachment objects), so
  deleting it in one mailbox never touches another.
- One report files to at most as many mailboxes as fit the Worker's
  subrequest budget (`M365_JOURNAL_SUBREQUEST_BUDGET`, default 8,000, about
  four plus one per attachment per copy; Workers Paid allows 10,000 per
  invocation by default, raise `[limits] subrequests` in the Worker's
  wrangler file before raising this:
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)).
  With the default, a message with no attachment reaches about 2,000
  mailboxes; copies beyond that are skipped with reason `budget`.
- If storing a copy fails (R2 or D1 error), the Worker reports the delivery
  as failed after filing the rest, so that a redelivered report files what is
  missing. Whether Email Routing then gives Exchange a temporary failure is
  not documented by Cloudflare.

## Aliases

People have addresses besides their primary one (`proxyAddresses` in
Microsoft 365). Without them, mirrored mail to an alias would count as
unmatched. The **alias import** (its own switch in Admin > Exchange mirror,
off by default) adds them:

- It runs with the Microsoft 365 sync ([m365-sync.md](m365-sync.md)), using
  the same read-only app and `User.Read.All` permission: once per
  `M365_SYNC_INTERVAL_MINUTES`, it reads every user's `proxyAddresses`
  (`GET /users?$select=id,proxyAddresses`, 999 per page;
  [user resource](https://learn.microsoft.com/en-us/graph/api/resources/user):
  `SMTP:` is the primary address, `smtp:` the others, "Requires `$select` to
  retrieve"). Shared mailboxes are user objects too.
- It needs the sync on and **out of dry run**; in dry run it only counts.
- Only `smtp:` addresses on the organisation's mail domains (`MAIL_DOMAIN`,
  plus the tenant's verified domains the sync discovered:
  [Multiple mail domains](multi-domain.md)), of objects the sync has linked
  to a cmail mailbox (a person's own mailbox, or a shared mailbox), are kept.
  `*.onmicrosoft.com` addresses are never kept.
- An alias is **never** another mailbox's own address: such an address is
  refused and counted. An address claimed by two objects is refused for
  both. A database trigger enforces the same rule for any writer, and
  creating or renaming a mailbox to an alias address drops the alias (the
  real mailbox always wins).
- An alias moves to another mailbox only when Microsoft 365 lists it there
  and no longer on the old one. A listing that suddenly holds no aliases
  removes nothing (held).
- **Mass-removal brake.** A run that would remove more than 20 percent of
  the aliases held (and at least 5) is more likely a partial listing than a
  real change: it applies its additions and moves, holds the removals, and
  counts as held. Admin shows **Approve alias removals**; after a manager
  approves (audited, `org.m365_alias_removals_approved`), the next run
  applies them. An approval is cleared at the end of that next run whatever
  it did, so an unused approval never authorises a later removal. Changes are audited (`m365_sync.aliases_changed`,
  counts only).
- **Freshness.** The mirror uses imported aliases only while the import is
  switched on and its last full, successful run (not held, not failed) is
  under 3 days old. Otherwise mail to an alias counts as unmatched, Admin
  says so, and the day's latest problem reads `aliases_stale`.
- Only the Exchange mirror reads aliases. Normal inbound mail to an alias is
  still refused as an unknown address, so turning this on changes nothing for
  cmail's own mail. (Accepting aliases on the normal path, for after a switch
  to cmail, is a separate change.)
- Turning the import off stops the mirror using aliases at once; the rows
  stay until the import runs again.

## How to set up the Exchange mirror

Onboarding a Microsoft 365 organisation end to end? See [the onboarding guide](onboarding-microsoft-365.md#10-exchange-mirror-optional), step 10, with `scripts/onboarding/exchange-mirror.ps1` for the Exchange side.

Order matters: cmail first, then Cloudflare, then Exchange. Every step that
changes a live system needs the owner's yes.

### 1. cmail

1. Apply migration `0027` (`pnpm db:migrate`). It adds three tables and
   four triggers and changes no existing row. Two triggers guard
   `mailbox_aliases` itself and only run when aliases are written (alias
   import on). Two run on every mailbox insert or address change, but their
   `WHEN` clause is one indexed lookup in `mailbox_aliases` that is false
   while that table is empty, so with the alias import never turned on their
   body never runs.
2. Choose the journal domain. It must be a domain whose MX already points at
   Cloudflare Email Routing. Cloudflare Email Routing needs exclusive control
   of a domain's root MX (error 2008 while another provider's MX is there;
   see [standby-probe.md](standby-probe.md)), so the simplest choice is a
   separate domain used only for this, on Cloudflare. A subdomain of the main
   domain works only if subdomain routing next to an Exchange apex MX works on
   your account (unproven).
3. On the email Worker, set:

   | Setting | Value |
   |---|---|
   | `M365_JOURNAL_ADDRESS` | `journal-<32+ random lower-case hex>@<journal domain>`. Store it as a secret: `wrangler secret put M365_JOURNAL_ADDRESS --config apps/email-worker/wrangler.toml` |
   | `M365_TENANT_ID` | The directory (tenant) ID (shared with the sync). Turns on the tenant check. |
   | `M365_JOURNAL_SENDER_DOMAINS` | Domains whose DKIM signature on a report is accepted (check 5a). Set it to exactly what the diagnostic shows real reports are signed with, typically `<tenant>.onmicrosoft.com`. The default, `MAIL_DOMAIN`, also matches cmail's own outgoing DKIM: replace it once you know. |
   | `M365_JOURNAL_NDR_DOMAIN` | The domain of the "undeliverable journal reports" address (check 5b). Use a **dedicated** domain or subdomain used for nothing else (for example `journal-ndr.example.com`), whose SPF record lists only `include:spf.protection.outlook.com` plus the include Cloudflare Email Routing needs to receive its NDRs (`include:_spf.mx.cloudflare.net`), so no other system can pass SPF for it. Optional. |
   | `INBOUND_AUTHSERV_ID` | `mx.cloudflare.net` |
   | `MAIL_DOMAIN` | As for the web app. |
   | `MAX_INBOUND_BYTES` | Optional: raise toward 26214400 (25 MiB) to mirror large messages; see [Size limits](#size-limits). |
   | `M365_JOURNAL_MIRROR_SENT` | Optional, default `"false"`. Set `"true"` (needs `M365_TENANT_ID`) only after the first live test shows real originals carry `X-MS-Exchange-CrossTenant-AuthAs: Internal` and the tenant id. |
   | `M365_JOURNAL_REQUIRE_AUTH` | Leave at `"true"` with check 5a or 5b set up. `"false"` is the fallback: it needs `M365_TENANT_ID`, and every report must then carry that tenant id; only the token, the journal header and the tenant header protect the address. |

4. Deploy the email Worker and web app. In Admin > Exchange mirror the
   settings show as configured (the address masked). Leave the switch **off**.

### 2. Cloudflare Email Routing

In the Cloudflare dashboard, on the journal domain: **Compute > Email Service
> Email Routing**, add a routing rule for the custom address
`journal-<token>` with the action **Send to a Worker** and the cmail email
Worker. One rule; nothing per mailbox
([Email Routing addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)).

### 3. Exchange Online

Needs the Exchange Online "Journaling" permission
([feature permissions](https://learn.microsoft.com/en-us/exchange/permissions-exo/feature-permissions)).

1. **Undeliverable journal reports.** Choose a mailbox **outside Exchange
   Online** that a person reads, for example a cmail shared mailbox reached
   at its standby address, or another provider. Microsoft requires it ("the
   alternate journaling mailbox can't be an Exchange Online mailbox") and
   sends it every report that cannot be delivered, with the report attached
   ([Configure journaling](https://learn.microsoft.com/en-us/exchange/security-and-compliance/journaling/configure-journaling)).

   PowerShell ([Set-TransportConfig](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-transportconfig)):

   ```powershell
   Connect-ExchangeOnline
   Set-TransportConfig -JournalingReportNdrTo journal-ndr@ndr.example.com
   ```

   Portal: Microsoft Purview portal > **Solutions > Data lifecycle
   management > Exchange (legacy)**, settings, **Send undeliverable journal
   reports to** (this location comes from archiving vendors' guides; Microsoft
   documents only the PowerShell above).

2. **Keep the original as MIME, not TNEF.** cmail reads the original only as
   an attached `message/rfc822`. Make sure Exchange never sends TNEF
   (`winmail.dat`) to the journal domain
   ([New-RemoteDomain](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/new-remotedomain)):

   ```powershell
   New-RemoteDomain -Name "cmail journal" -DomainName journal.example.net
   Set-RemoteDomain -Identity "cmail journal" -TNEFEnabled $false
   ```

   A report that arrives as TNEF is refused with reason `tnef`.

3. **The journal rule** (one rule, all users, all messages;
   [Manage journaling](https://learn.microsoft.com/en-us/exchange/security-and-compliance/journaling/manage-journaling)).

   Portal: Microsoft Purview portal > **Solutions > Data lifecycle management
   > Exchange (legacy) > Journal rules > + New rule**:
   - **Send journal reports to**: `journal-<token>@<journal domain>`
   - **Journal rule name**: `cmail mirror`
   - **Journal messages sent or received from**: apply the rule to all
     messages (no specific recipient)
   - **Type of message to journal**: all messages, regardless of origin or
     destination
   - **Next**, **Submit**.

   (Classic EAC: **Compliance management > Journal rules > Add**, the same
   three choices.)

   PowerShell ([New-JournalRule](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/new-journalrule);
   no `-Recipient` means all recipients; new rules are disabled unless
   `-Enabled $true`):

   ```powershell
   New-JournalRule -Name "cmail mirror" -JournalEmailAddress journal-<token>@journal.example.net -Scope Global -Enabled $false
   ```

   Create it **disabled**, turn the mirror on in cmail (step 4), then enable
   it: `Enable-JournalRule -Identity "cmail mirror"`.

### 4. Turn it on and check

1. Admin > Exchange mirror > **Turn Exchange mirror on**.
2. `Enable-JournalRule -Identity "cmail mirror"`.
3. Send a test message from one licensed user to another and to an external
   address. Within a minute Admin shows a last report time and "filed" for
   the recipient, and the trace shows one "Exchange mirror" line. Check in a
   copy of the stored original that it carries
   `X-MS-Exchange-CrossTenant-AuthAs: Internal` and your tenant id before
   turning on `M365_JOURNAL_MIRROR_SENT`.
4. If the counts show refused reports, the reason is in Admin and the audit
   log (see [Troubleshoot refused reports](#troubleshoot-refused-reports)).
   `auth_failed` or `auth_missing`: compare the DKIM `d=` and the SPF
   `smtp.mailfrom` domain in the diagnostic with `M365_JOURNAL_SENDER_DOMAINS`
   and `M365_JOURNAL_NDR_DOMAIN`. `wrong_tenant`: compare the
   `x-ms-exchange-crosstenant-id` values with `M365_TENANT_ID`.

### Troubleshoot refused reports

Each refused report's audit row (`exchange_mirror.report_rejected`, at most
50 a day) carries a safe diagnostic: from the OUTER report only, the names
and values of its `X-MS-Exchange-CrossTenant-*`,
`X-MS-Exchange-Organization-*`, `X-MS-Journal-Report` and
`Authentication-Results` headers reduced to safe values (see below), the `d=` and `s=` of each
`DKIM-Signature`, and how many headers with those names the attached
original has (a count only). Never a subject, an address, a body or any
other header; at most 30 headers and 3,000 characters.

Exactly which headers: an allowlist of names (`X-MS-Journal-Report`,
`X-MS-Exchange-CrossTenant-Id`, `-Network-Message-Id`, `-AuthAs`,
`-AuthSource`, `-FromEntityHeader`, `-MailboxType`, `-OriginalArrivalTime`,
`X-MS-Exchange-Organization-Network-Message-Id`, `-AuthAs`, `-AuthSource`,
`-SCL`, `Authentication-Results`, `DKIM-Signature`). A value is kept only if
it has that header's expected shape (a GUID, a date, or a short token of
letters, digits, `.`, `_` and `-`); otherwise only its length is shown. For
`Authentication-Results` only the authserv-id, each method and verdict, and
the domain of `header.d`, `header.i`, `header.from` and `smtp.mailfrom` are
kept: comments, quoted text (so quoted local parts and display names), local
parts, reasons and IP addresses never are.
5. Optional: Admin > Exchange mirror > **Turn alias import on** (needs the
   Microsoft 365 sync on and out of dry run).

## Admin

Admin > Exchange mirror (managers only) shows:

- The mirror switch, the masked journal address, trusted sender domains and
  whether the authentication, tenant and Sent options are on, or the list of
  missing settings.
- Status: last report time, and today's counts: received, filed (recipients),
  Sent, duplicates, unmatched recipients, skipped copies and refused reports,
  with the latest problem in plain words; the last 7 days in a table. Counts
  are kept 90 days.
- The alias import switch, aliases held and the last import's result and
  changes.

Turning either switch on or off is audited (`org.exchange_mirror_toggled`,
`org.m365_alias_sync_toggled`). The mail trace has one line per report
(counts only, never the journal address).

## Size limits

- **Cloudflare Email Routing:** 25 MiB per message; larger messages are
  rejected at SMTP
  ([limits](https://developers.cloudflare.com/email-routing/limits/)). A
  journal report is the original plus a small envelope, so originals close to
  25 MiB are refused by Cloudflare and Exchange sends the report to the
  undeliverable-reports mailbox.
- **cmail:** the original must fit `MAX_INBOUND_BYTES` (default 10 MiB, at
  most 25 MiB), attachments together at most 15 MiB, and the normal
  attachment count and decoded body limits. Bigger messages are skipped and
  counted.
- Exchange Online can be set to allow larger messages (up to 150 MB per
  [Exchange Online limits](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits));
  those are never mirrored.

## Privacy

The mirror copies every message of every journaled user into cmail. That is
its purpose, and it means cmail holds the same mail as Exchange: apply the
same access rules, retention and data-handling notices to it
([privacy-and-data-handling.md](privacy-and-data-handling.md)). Tell staff the
standby holds a copy of their mail. Admin, the audit log, the trace and logs
hold counts and reason codes only; the trace line also has the subject and
From of a filed message, as for any delivery. A refused report's content is
never stored. The journal address is a secret: anyone who has it and can pass
the checks above could add mail to mailboxes, so keep it in Worker secrets
and Exchange only, and rotate the token if it may have leaked.

## How to rotate the journal token

Do this if the journal address may have leaked (a screenshot, a ticket, a
former admin), or once a year. No mail is lost: Exchange queues reports while
the old address refuses them, and retries.

1. Generate a new token: `openssl rand -hex 16`. The new address is
   `journal-<new token>@<journal domain>`.
2. Cloudflare: add a routing rule for the new address (Send to the cmail
   email Worker). Keep the old rule for now.
3. Worker: `wrangler secret put M365_JOURNAL_ADDRESS --config apps/email-worker/wrangler.toml`
   with the new address. From now on the old address is refused like any
   unknown address.
4. Exchange: point the rule at the new address:
   `Set-JournalRule -Identity "cmail mirror" -JournalEmailAddress journal-<new token>@<journal domain>`
   ([Set-JournalRule](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-journalrule)).
   Do it within minutes of step 3: reports sent to the old address in
   between are refused, go to the undeliverable-reports mailbox, and can be
   resent from there with Outlook's **Send Again**
   ([Configure journaling](https://learn.microsoft.com/en-us/exchange/security-and-compliance/journaling/configure-journaling)).
5. Check Admin > Exchange mirror shows a new last report time.
6. Cloudflare: delete the old address's routing rule.

## How to turn it off and roll back

1. Exchange: `Disable-JournalRule -Identity "cmail mirror"` (or Purview >
   Journal rules > Disable). Reports stop. Remove it later with
   `Remove-JournalRule -Identity "cmail mirror"`.
2. cmail: Admin > Exchange mirror > **Turn Exchange mirror off**. Any report
   still in flight is refused like an unknown address (Exchange sends it to
   the undeliverable-reports mailbox).
3. Optional: Cloudflare: delete the `journal-<token>` routing rule; unset
   `M365_JOURNAL_ADDRESS`.
4. Mirrored mail stays in cmail; nothing is deleted automatically. A manager
   can remove it like any other mail.
5. The alias import: turn it off. To remove imported aliases, delete the rows
   in `mailbox_aliases` (they are used only by the mirror).
6. The migration is additive; leaving it applied is harmless.

## What Exchange Online actually stamps

From the safe diagnostic of a live outer journal report (16 Nov 2026; tenant
and server names left out):

| Header on the outer report | Seen |
|---|---|
| `Authentication-Results` (Cloudflare's) | `dmarc=fail header.from=<the original external sender's domain>; spf=pass smtp.mailfrom=<the NDR domain>; arc=none`. No `dkim=` result. `smtp.mailfrom` is recorded as a bare domain. |
| `X-MS-Journal-Report` | present, empty |
| `X-MS-Exchange-CrossTenant-AuthAs` | `Internal` |
| `X-MS-Exchange-CrossTenant-AuthSource` | your tenant's Exchange Online server (`….PROD.OUTLOOK.COM`) |
| `X-MS-Exchange-CrossTenant-FromEntityHeader` | `Hosted` |
| `X-MS-Exchange-CrossTenant-OriginalArrivalTime` | a date |
| `X-MS-Exchange-CrossTenant-Network-Message-Id` | a GUID |
| `X-MS-Exchange-CrossTenant-Id` | **absent** on this report (another, earlier report carried your id, and one from another Microsoft 365 organisation's sender carried theirs and yours) |
| `DKIM-Signature` | **absent**: check 5a cannot pass on such reports |

So with authentication on, these reports pass by check 5b: SPF for the NDR
domain plus AuthAs `Internal`.

## What is not verified

Microsoft does not document these, and they could only be settled with a
real tenant:

- **Seen on a live tenant (16 Nov 2026).** The report's From is the
  original sender, its Message-ID ends `@journal.report.generator`, and its
  envelope MAIL FROM is the "undeliverable journal reports" address. So
  DMARC on the From cannot prove the tenant, and the first design refused
  every report with authentication on. A report from another Microsoft 365
  organisation's sender carried more than one tenant id.
- **Exchange Online MAIL FROM enforcement (check 5b).** Whether Exchange
  Online stops other tenants from sending with a MAIL FROM on your NDR
  domain is not documented by Microsoft. Check 5b relies on it.
- **DKIM of journal reports.** The live reports seen so far carried no
  `dkim=` result; whether Exchange Online ever DKIM-signs journal reports is
  not documented. A Microsoft Q&A thread reports them unsigned
  ([Q&A](https://learn.microsoft.com/en-us/answers/questions/1153499/how-to-enable-dkim-for-journaling)).
  The diagnostic shows it on the first refused report. Check 5b does not
  depend on it.
- **Cloudflare acceptance.** Live reports were accepted because SPF passed
  for the NDR domain. Cloudflare Email Routing refuses mail that passes
  neither SPF nor DKIM
  ([postmaster](https://developers.cloudflare.com/email-service/reference/postmaster/#mail-authentication-requirement)).
  An unsigned report with an empty envelope sender might be refused before
  cmail sees it.
- **Report layout.** The field-level format is documented only for
  Exchange 2007; the attachment type (`message/rfc822`), the order Sender,
  Subject, Message-Id, then recipients, and the `Expanded:` line format are
  assumed from it. A different layout is refused (`no_original`,
  `unsafe_envelope`, `no_recipients`), never misfiled.
- **Tenant headers.** Which `X-MS-Exchange-CrossTenant-*` headers Exchange
  Online stamps on the outer report is not documented by Microsoft; the
  diagnostic shows them. Whether `X-MS-Exchange-CrossTenant-AuthAs` is
  present on the attached original is also unknown. If they are missing on real originals, Sent copies are
  never filed (they are off by default and fail closed).
- **Envelope Message-Id.** Assumed to equal the original's Message-ID header
  (Microsoft calls it "the internal Exchange Message-ID"). If it differs on
  real reports, every report is refused `message_id_mismatch`.
- **HTML envelopes.** Assumed plain text; an HTML-only envelope is refused.
- **Shared mailbox recipients** in the envelope (not documented; assumed to
  appear as normal recipient lines).
- **Retries.** Whether a Worker error becomes a temporary SMTP failure that
  Exchange retries.
- The subdomain routing question in [standby-probe.md](standby-probe.md), if
  the journal address is on a subdomain of an Exchange-hosted domain.

## How to test

```sh
pnpm --filter @cmail/email-worker exec vitest run src/exchange-mirror/ src/graph-mirror/ src/m365-sync/aliases.sql.node.test.ts
pnpm --filter @cmail/web exec vitest run src/lib/server/exchange-mirror-admin.test.ts src/lib/server/graph-mirror-admin.test.ts src/routes/admin/exchange-mirror/
```

The Graph source tests (`apps/email-worker/src/graph-mirror/graph-mirror.sql.node.test.ts`)
run the real filing code on a real SQLite database with every migration,
against a fake Microsoft Graph: Inbox, Archive and Sent copies per linked
mailbox; replays and read-state changes counted without a download; a
message filed once whichever source brings it first; no second Sent copy of
cmail's own mail; Focused Inbox colleague proof; size, Message-ID and
attachment limits; the first-pull window and cap; Import older mail; 429 per
mailbox and while reading a message; 410 from the watermark; permission
missing and a mailbox outside the scope; rejected credentials; the budget
with resume and no message downloaded twice; and the switch off being inert.
The web tests check the Admin actions and that the standby note renders.

The Worker tests drive the real inbound handler on a real SQLite database
with every migration, with reports shaped like Exchange's
(`apps/email-worker/src/exchange-mirror/fixtures.ts`): filing per recipient,
Bcc and group expansion, aliases, duplicates and split reports, Sent copies
and when they are refused, forged reports (no journal header, another tenant,
no or foreign authentication, a record from another boundary, injected
envelope lines, TNEF, two originals, a From or DKIM domain that only starts
with the tenant domain, a mismatched Message-Id), size (refused before the
report is read), quota and budget limits, the hourly inbound guard turned on
(mirrored copies never use it up), alias freshness and the mass-removal
brake, no inbox rules, no notification, nothing ever sent, and that with the
mirror configured and on, normal delivery to a mailbox runs exactly the same
SQL with the same bound values and R2 writes as with it unconfigured.
