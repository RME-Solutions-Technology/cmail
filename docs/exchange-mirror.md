# Exchange mirror (warm standby from Exchange Online journaling)

Status: **built, off by default, not yet tested against a real Exchange
Online tenant or a real Cloudflare account.** The code paths are covered by
tests with journal reports built from Microsoft's documented format (see
[How to test](#how-to-test)). Several details of a real Exchange Online
journal report are not documented by Microsoft and must be checked on the
first live test: see [What is not verified](#what-is-not-verified).

cmail's main use is primary email for a small organisation. This feature is
for the other case: an organisation that stays on Exchange Online and wants
cmail as a live copy ("warm standby") of every mailbox, so that if Exchange
fails, people already have their recent mail in cmail. It needs **no setup
per address**: one Exchange journal rule, one Cloudflare Email Routing rule
and two cmail switches cover a tenant of any size (built for 200+ seats and
500+ addresses).

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

## Contents

- [Why journaling](#why-journaling)
- [What is and is not mirrored](#what-is-and-is-not-mirrored)
- [How a report is trusted](#how-a-report-is-trusted)
- [How mail is filed](#how-mail-is-filed)
- [Aliases](#aliases)
- [Setup](#setup)
- [Admin](#admin)
- [Size limits](#size-limits)
- [Privacy](#privacy)
- [Rollback](#rollback)
- [What is not verified](#what-is-not-verified)
- [How to test](#how-to-test)

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
| Graph mailbox copy (cmail's copy-back in reverse) | Needs `Mail.Read` on every mailbox, polling per mailbox and much more API traffic; journaling pushes each message once. |

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
  and ignored.
- Exchange's own spam verdict. A cmail organisation-wide sender **block**
  rule still files the copy to Spam, as on the normal path.
- Messages larger than the limits in [Size limits](#size-limits).
- Mail sent with encryption from outside the organisation stays encrypted.
  For the organisation's own Microsoft Purview Message Encryption, turn on
  journal report decryption (`Set-IRMConfiguration -JournalReportDecryptionEnabled $true`,
  [Journaling](https://learn.microsoft.com/en-us/exchange/security-and-compliance/journaling/journaling)).

Nothing a mirrored copy does can send mail: no inbox rules run on it, no
forwarding, no auto-reply, no bounce, no read receipt, and no new-mail
notification (people are still reading in Outlook). The only SMTP answer
cmail ever gives is Cloudflare's own refusal of a report that fails the
checks below.

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
> the address secret and [rotate the token](#rotating-the-journal-token) if
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
- Only `smtp:` addresses on `MAIL_DOMAIN`, of objects the sync has linked to
  a cmail mailbox (a person's own mailbox, or a shared mailbox), are kept.
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

## Setup

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
   log (see [Diagnosing refused reports](#diagnosing-refused-reports)).
   `auth_failed` or `auth_missing`: compare the DKIM `d=` and the SPF
   `smtp.mailfrom` domain in the diagnostic with `M365_JOURNAL_SENDER_DOMAINS`
   and `M365_JOURNAL_NDR_DOMAIN`. `wrong_tenant`: compare the
   `x-ms-exchange-crosstenant-id` values with `M365_TENANT_ID`.

### Diagnosing refused reports

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

## Rotating the journal token

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

## Rollback

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
- **DKIM of journal reports.** Whether Exchange Online DKIM-signs journal
  reports, and with which domain, is still not known; a Microsoft Q&A thread
  reports them unsigned
  ([Q&A](https://learn.microsoft.com/en-us/answers/questions/1153499/how-to-enable-dkim-for-journaling)).
  The diagnostic shows it on the first refused report. Check 5b does not
  depend on it.
- **Cloudflare acceptance.** Cloudflare Email Routing refuses mail that
  passes neither SPF nor DKIM
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
pnpm --filter @cmail/email-worker exec vitest run src/exchange-mirror/ src/m365-sync/aliases.sql.node.test.ts
pnpm --filter @cmail/web exec vitest run src/lib/server/exchange-mirror-admin.test.ts src/routes/admin/exchange-mirror/
```

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
