# Focused Inbox

Focused and Other tabs above the Inbox, like Outlook's
[Focused Inbox](https://support.microsoft.com/en-us/office/focused-inbox-for-outlook-f445ad7f-02f4-4294-a82e-71d8964e3978).
Mail from people stays in **Focused**; newsletters, notifications and other
automated mail go to **Other**. It works for every cmail mailbox, personal or
shared, whatever the mail came through (Cloudflare Email Routing, the
Exchange mirror, or another cmail mailbox).

**Status:** built, off by default, covered by unit, database and browser tests.
Not yet tried on a live deployment.

- [What people see](#what-people-see)
- [Turning it on and off](#turning-it-on-and-off)
- [How a message is sorted](#how-a-message-is-sorted)
- [Learning: move and "always move"](#learning-move-and-always-move)
- [Sorting mail that already arrived](#sorting-mail-that-already-arrived)
- [What does not change](#what-does-not-change)
- [Storage, privacy and audit](#storage-privacy-and-audit)
- [Upgrade](#upgrade)
- [Limits and known gaps](#limits-and-known-gaps)
- [Code and tests](#code-and-tests)

## What people see

- **Focused | Other tabs** above the Inbox list, each with its unread count.
  They are real tabs for assistive technology (`tablist`, `tab`, `tabpanel`):
  one tab stop, then arrow keys, Home and End move between them, and Enter or
  Space opens one. On a phone the two tabs share the width and are 44 px tall.
- **Other is still the Inbox.** A message in Other is in the Inbox folder; it
  is not moved, hidden, archived or deleted. Focused plus Other is always the
  whole Inbox. Messages that were never sorted (for example, mail from before
  the feature was turned on) show under Focused.
- **Search ignores the tabs.** Searching covers the whole Inbox and shows no
  tabs. Sent, Drafts, Archive, Spam and Trash have no tabs.
- **"All mailboxes" view.** Each mailbox follows its own setting: the Other
  tab lists Other mail from the mailboxes that are sorted; everything from a
  mailbox with sorting off stays under Focused.
- **In a message**, a short line says which tab it is in and why (for example
  "The sender address looks automated"), with **Move to Other** /
  **Move to Focused** and **Always move messages from this sender to …**
  (people with Full access only).
- **In the list**, select messages and use **Move to Other** or
  **Move to Focused** (Full access only).
- The unread count beside the mailbox in the navigation is unchanged: it
  still counts the whole Inbox, because Other is part of it.

## Turning it on and off

There are two switches.

| Switch | Where | Default | Who |
| --- | --- | --- | --- |
| Organisation | **Admin > Settings > Focused Inbox** | Off | Managers |
| Per mailbox | **Mail > Settings > Focused Inbox** | On, once the organisation switch is on | Anyone with Full access to that mailbox |

- With the organisation switch **off**, nothing about the Inbox changes: the
  list runs exactly the same query, there are no tabs, the Mail settings page
  has no Focused Inbox section, and delivery stores nothing new. What it
  still costs (a few small settings reads and one index write per Inbox
  change) is listed under [What it costs](#what-it-costs-on-and-off).
- The per-mailbox setting belongs to the **mailbox**, not the person. For a
  personal mailbox that is its owner; for a shared mailbox, everyone with Full
  access changes the same setting, and everyone assigned to it (any level)
  sees its tabs. A person who wants one list turns it off for their mailbox.
- Turning it off leaves the stored tabs in place (harmless; they are only
  used while it is on). Turning it back on uses them again and sorts recent
  mail that arrived in between.

Both switches are recorded in the audit log (`org.focused_inbox_toggled`,
`focus.mailbox_toggled`).

## How a message is sorted

Only a message that is still going to the **Inbox** after the organisation's
spam filing ([Spam and quarantine](spam-and-quarantine.md)) and the
mailbox's [inbox rules](inbox-rules.md) is sorted. A message a rule files to
Archive, or that lands in Spam, gets no tab.

Sorting is deterministic and explainable. It uses the sender address, a few
standard headers, and this mailbox's own history. No message content is
read, no AI is used, and nothing leaves cmail. The first signal that applies
decides, in this order:

| # | Signal | Goes to | Reason code |
| --- | --- | --- | --- |
| 1 | The mailbox has an entry for this exact sender address | the entry's tab | `sender_override` |
| 2 | The mailbox has an entry for the sender's domain (or a parent domain: `example.org` covers `news.example.org`) | the entry's tab | `domain_override` |
| 3 | The message is a delivery status report (`Content-Type: multipart/report; report-type=delivery-status`, [RFC 3464](https://www.rfc-editor.org/rfc/rfc3464)): a bounce about mail you sent | Focused | `delivery_report` |
| 4 | `Auto-Submitted` with any value but `no` ([RFC 3834](https://www.rfc-editor.org/rfc/rfc3834)): out-of-office and other machine replies | Other | `auto_submitted` |
| 5 | **Authenticated** sender this mailbox has sent mail to (To, Cc or Bcc of its newest 2,000 Sent messages), even if the message has list headers | Focused | `correspondent` |
| 6 | `List-Id` ([RFC 2919](https://www.rfc-editor.org/rfc/rfc2919)) or `List-Unsubscribe` ([RFC 2369](https://www.rfc-editor.org/rfc/rfc2369)) | Other | `mailing_list` |
| 7 | `Precedence: bulk`, `list` or `junk` (widely used, not a standard) | Other | `bulk_precedence` |
| 8 | **Authenticated** sender whose domain is exactly `MAIL_DOMAIN` (or, for mail from another cmail mailbox, that mailbox's domain) | Focused | `internal` |
| 9 | The sender address looks automated: the part before `@`, without `+tag` and `. _ -`, starts with `noreply` or `donotreply`, or is `notification(s)`, `newsletter(s)`, `news`, `marketing` or `mailer` | Other | `automated_sender` |
| 10 | Personal mailboxes only: 20 or more of the mailbox's newest 500 Inbox messages are from this exact address, and it has never been written to | Other | `frequent_sender` |
| 11 | Anything else | Focused | `default` |

**Authenticated** means the From address is proven:

- normal inbound mail: a DMARC `pass` in the Authentication-Results record of
  the trusted boundary (`INBOUND_AUTHSERV_ID`, see
  [Receiving](receiving.md)). Without `INBOUND_AUTHSERV_ID`, or without a
  DMARC pass, signals 5 and 8 are never used;
- the Exchange mirror: the original carries
  `X-MS-Exchange-CrossTenant-AuthAs: Internal` and this tenant's id on every
  instance (an authenticated submission by a user of this tenant, the same
  proof the mirror's Sent copy uses). Internet mail on the mirror is treated
  as unauthenticated;
- mail between cmail mailboxes: always (a signed-in user sent it).

So a forged From never earns a place in Focused as a "correspondent" or
"colleague", and the message view never says "The sender is in your
organisation" for an unproven sender.

Focused is the safe default: a person in Other costs more than a newsletter
in Focused, so every Other signal is specific, and a person's own entries
always win. `moved` marks a message someone moved by hand.

Notes on the signals:

- **Headers** are read from the parsed message (postal-mime) on the normal
  inbound path, and from the original message inside a journal report on the
  [Exchange mirror](exchange-mirror.md). Only the message's own (first)
  `Content-Type` counts for signal 3.
- **Shared mailboxes** skip signal 10: their replies usually go out from
  people's personal mailboxes, so "never written to" says nothing there.
- **Scans are skipped when they cannot change the answer**: the Sent scan
  only runs for an authenticated sender not already decided by signal 3 or
  4; the frequency count only when no header, automated-looking address or
  internal match decides first.
- **Contacts.** cMail has no address book: its recipient suggestions
  (`mailbox_contacts`) include every sender that ever wrote in, so they are
  not used. Signal 5 (people you have written to) stands in for "is a
  contact", as Outlook does with correspondence history.
- **Shared mailboxes** are sorted with their own history and entries.
- The **standby test address** and cmail's own notices (bounce notices, which
  are written straight to the Inbox) are not sorted and show under Focused.

## Learning: move and "always move"

- **Move to Other / Move to Focused** changes that message only
  (`focus_reason = 'moved'`).
- **Always move messages from this sender to …** (from a message) also saves
  an entry for that exact sender address on **that mailbox**, and moves the
  sender's other Inbox messages in that mailbox to the same tab. New mail from
  them follows the entry (signal 1). This matches Outlook's "Always move to
  Other", which applies to all future messages from that sender.
- Entries are per mailbox. They are never shared between mailboxes or
  people, and never become organisation-wide. (Organisation-wide allow and
  block lists are a different feature: [Spam and quarantine](spam-and-quarantine.md).)
- **Mail > Settings > Focused Inbox** lists each mailbox's entries, lets you
  remove them, and lets you add a sender address (`news@example.org`) or a
  domain (`example.org`, which also covers its subdomains) for Focused or
  Other. An entry changes new mail; use the list's Move buttons for mail
  already there. Up to 1,000 entries per mailbox.
- Moving needs **Full access** to the mailbox (read-only and Send-as
  delegates can see the tabs but not move). Every move is audited as
  `focus.messages_moved` with counts only; entry changes as
  `focus.override_saved` / `focus.override_removed` with the mailbox and the
  kind of entry, never the address.

## Sorting mail that already arrived

When sorting is on for a mailbox, its newest **1,000** never-sorted Inbox
messages are sorted once, in the background:

- It starts after someone opens that mailbox's Inbox (at most two mailboxes
  per page load) or turns the mailbox's setting on, and runs after the page
  has been sent ([`waitUntil`](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil),
  which allows up to 30 seconds after the response).
- It is bounded: a fixed number of reads (the 1,000 messages, the mailbox's
  entries, its correspondents among those senders, and its frequent
  senders) and at most 1,000 rows changed, in one D1 batch, which D1 runs as
  [one transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
- It only fills in messages that are still unsorted: a delivery or a move
  during the run wins.
- A five-minute lease stops two runs for the same mailbox at once; a run that
  was cut off is started again on a later Inbox visit once its lease has
  expired, and a late run can never close the run that took over. Turning the
  organisation switch back on queues the sort again for every mailbox, for
  mail that arrived while it was off. The state
  (`running`, `done` with a count, or `failed`) shows in Mail > Settings; a
  failed run has a **Try again** button.
- cmail does not keep raw headers or authentication results of stored mail,
  so signals 3, 4, 6 and 7 cannot be used here, and signals 5 and 8 only for
  mail that came from another cmail mailbox. Old newsletters are caught only
  by the person's entries, signal 9 (automated-looking address) or signal 10
  (frequent sender). New mail gets all signals.

## What does not change

- Delivery itself: storage, quotas, the mail trace, new-mail alerts, inbox
  rules, spam filing, Exchange mirror filing. Sorting is one extra statement
  in the same D1 batch as the message row, so a message and its tab are
  saved together or not at all. If the lookup fails, the message is
  delivered with no tab (logged without addresses or content).
- Folders, search, message moves between folders, the MCP tools and
  retention. A message keeps its tab if it leaves the Inbox and comes back.

## Storage, privacy and audit

| Where | What |
| --- | --- |
| `messages.focus_class` | `focused`, `other`, or NULL (never sorted) |
| `messages.focus_reason` | One reason code from the table above (at most 32 characters) |
| `focus_mailbox_settings` | One row per mailbox that changed its setting or was sorted: on/off, and the state of the one-off sort |
| `focus_sender_overrides` | The per-mailbox entries: kind (`address` or `domain`), the lower-cased address or domain, the tab, who added it and when |
| `org_settings` key `focused_inbox_enabled` | The organisation switch (`true` = on) |

Logs carry no addresses, subjects or content. Audit details carry counts and
kinds only.

### What it costs, on and off

With the organisation switch **off** (nothing is cached; each request reads
the switch afresh, so turning it off takes effect at once):

- each Inbox list load: one `org_settings` read;
- each open of a received Inbox message: one small read (the switch and the
  mailbox's setting) before showing the Move line;
- Mail settings and Admin settings: one read each;
- each delivery to an Inbox (normal inbound and mail between cmail
  mailboxes): one lookup statement, which returns after reading the two
  settings rows (SQLite evaluates a `CASE` branch only when it is taken:
  ["Both forms of the CASE expression use lazy, or short-circuit, evaluation"](https://www.sqlite.org/lang_expr.html#the_case_expression));
- each Exchange mirror report filed to an Inbox: one switch read;
- every Inbox insert and every move into or out of the Inbox also updates
  the partial index `idx_messages_inbox_focus` (one extra index write),
  because the migration creates it whether or not the feature is used.

With the switch **on**, each Inbox delivery's lookup also reads the
mailbox's entries and, when needed, scans its newest 2,000 Sent messages
and counts the sender in its newest 500 Inbox messages; the decision is one
extra `UPDATE` in the same D1 batch as the message row. On the Exchange
mirror each Inbox copy then counts one more subrequest against
`M365_JOURNAL_SUBREQUEST_BUDGET`. If the lookup fails (for example, the
migration is not applied), the message is delivered with no tab and one line
is logged per isolate.

The switch read is not cached between requests: a per-request cache saves
nothing (each request reads it once), and an isolate-level cache would keep
showing tabs for a while after a manager turns the feature off.

## Upgrade

Migration `0031_focused_inbox.sql`: additive only. Two nullable columns on
`messages`, one partial index (`idx_messages_inbox_focus`, Inbox rows only),
two new tables and one trigger. No existing row changes. Apply with the
normal `pnpm db:migrate` before (or together with) deploying the web app and
the email Worker. SQLite checks each `ADD COLUMN ... CHECK` against every
existing row, and building the index reads the table again: three passes
over `messages`. On a large database, run it outside busy hours.

Code deployed before the migration is safe: with the tables missing, the
switch reads as off and nothing new is written.

## Limits and known gaps

- The signals are rules, not a learning model. A sender who writes often but
  is not automated (signal 10) can land in Other until someone moves them
  with "always move"; a newsletter from an address you once wrote to stays in
  Focused (signal 5 beats list headers) unless you move it with "always move".
- Signals 5 and 8 need a proven From. Where the boundary records no DMARC
  result (`INBOUND_AUTHSERV_ID` unset, or Cloudflare adds no
  Authentication-Results), they never apply and such mail is sorted by the
  other signals only.
- Mail sorted while sorting was on keeps its tab after the setting is turned
  off and on again; only unsorted mail is sorted by the one-off run.
- The background sort covers 1,000 messages per mailbox; older mail stays
  under Focused.
- Not yet tested against live mail volume or a live Exchange tenant.

## Code and tests

- Classifier, header signals, delivery lookup:
  `packages/shared/src/focused-inbox.ts`; unit tests per signal and for the
  order: `packages/shared/src/focused-inbox.test.ts`.
- Delivery: `apps/email-worker/src/index.ts` (normal inbound),
  `apps/email-worker/src/exchange-mirror/ingest.ts` (mirror),
  `apps/web/src/lib/server/outbound-journal.ts` (mail between cmail
  mailboxes). Tests: `apps/email-worker/src/focused-inbox.sql.node.test.ts`
  (every signal, rules and spam first, switches, a failed lookup, the
  mirror) and `apps/web/src/lib/server/outbound-journal.failures.test.ts`.
- Web: `apps/web/src/lib/server/focused-inbox.ts` (views, counts, moves,
  entries, the one-off sort), `/api/messages/focus`, the Inbox list
  (`routes/mail/+page.*`), the message view (`lib/mail/FocusMove.svelte`),
  Mail settings and Admin settings. Tests:
  `apps/web/src/lib/server/focused-inbox.test.ts` (switch off leaves the list
  query and results unchanged, the two views, search and folders, moves and
  learning, limits, the one-off sort's bounds and lease, the switches).
- Browser: `e2e/mobile/focused-inbox.spec.ts` (off by default, tabs, keyboard,
  axe at desktop and phone sizes, phone layout, moving, off again). It turns
  the organisation switch on, so it runs as its own Playwright project after
  the device projects and as its own CI step.
