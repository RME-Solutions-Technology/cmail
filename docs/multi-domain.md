---
title: "Multiple mail domains"
summary: "How cmail serves every mail domain your organisation owns, found and proven automatically from Microsoft 365, with nothing to type in."
applies_to: both
audience: [manager, operator, developer]
switch: "Admin > Microsoft 365 sync (no switch of its own)"
last_reviewed: 2026-11-16
related: [m365-sync.md, exchange-mirror.md, sending.md, shared-mailboxes.md, focused-inbox.md]
---

# Multiple mail domains

One cmail instance serves one organisation. That organisation may own more
than one mail domain: a main domain and others for brands, products or older
names. cmail treats all of them as its own, without a domain list to fill in.

**Status:** built and tested against every real migration, a fake Microsoft
Graph and the real send, mirror and admin paths. Not yet run against a real
tenant. Sending from domains other than `MAIL_DOMAIN` is not built yet
([What does not change](#what-does-not-change)).

**In this article**

- [How the domains are found](#how-the-domains-are-found)
- [What uses the list](#what-uses-the-list)
- [What does not change](#what-does-not-change)
- [Security](#security)
- [How to turn it on](#how-to-turn-it-on)
- [How to roll it back](#how-to-roll-it-back)
- [Troubleshoot](#troubleshoot)
- [Upgrade](#upgrade)
- [Code and tests](#code-and-tests)

## How the domains are found

Domains are discovered and proven, never typed in by a manager:

1. **`MAIL_DOMAIN`**, the primary domain, always first.
2. **The Microsoft 365 tenant's verified domains**, when the
   [Microsoft 365 sync](m365-sync.md) is on and its app has `Domain.Read.All`.
   The sync reads them with Microsoft Graph
   [`GET /domains`](https://learn.microsoft.com/en-us/graph/api/domain-list)
   and keeps those with `isVerified`. A domain is verified in a tenant only
   after its owner proves it with a DNS record, so this list is proof of
   ownership.

Details:

- The tenant's initial `*.onmicrosoft.com` domain is never included.
- The sync reads the list at most once a day, and again on **Sync now**. It
  reads in dry run too, so a dry run report already covers every domain.
  The list is live from its first read, even in dry run: it only ever adds
  domains Microsoft has verified, and the domain picker in Admin and the
  mirror use it at once. Accounts and mailboxes are still created only by a
  live run.
- The list is cached in `org_settings` (key `m365_verified_domains`). Only
  the email Worker writes it; no Admin page or form can.
- **A failed read never shrinks the list.** Without the permission, while
  Microsoft is throttling, or on an empty or malformed answer (including one
  with only the initial domain where real ones were listed before), the last
  good list is kept, the problem shows in Admin, and the read is tried again
  within an hour. Throttling, network and sign-in failures also back the
  whole sync off, as any Graph failure does.
- **Only a successful read that no longer lists a domain removes it.** Every
  change to the list is written to the audit log
  (`m365_sync.domains_changed`, with the domains added and removed).
- **Turning the sync off freezes the list**, as it freezes the sync's links.
- With no Microsoft 365 sync, the list is `MAIL_DOMAIN` alone, and cmail
  behaves exactly as before.

Admin > Microsoft 365 sync shows the list under **Status > Mail domains**,
when it was last read, and any problem.

## What uses the list

Everything that used to ask "is this address on `MAIL_DOMAIN`?" now asks
"is it on one of the organisation's domains?". No new switches: each part
stays under the switch it already had.

| Part | With other domains | Switch |
|---|---|---|
| [Microsoft 365 sync](m365-sync.md) | People and shared mailboxes whose primary address is on any organisation domain get accounts and mailboxes. Shared mailbox detection and the group checks cover them too. | Microsoft 365 sync |
| Alias import ([Exchange mirror](exchange-mirror.md#aliases)) | `smtp:` addresses on every organisation domain become aliases. | Alias import |
| Exchange mirror filing | Journal copies are filed for mailboxes on every organisation domain. Once other domains have been discovered, a mailbox on a domain that is not one of them is counted as unmatched (problem `unmatched_domain`), never filed. With `MAIL_DOMAIN` alone, filing is by address exactly as before. | Exchange mirror |
| Sending to colleagues | With the mirror on, colleagues on every organisation domain are sent through the provider, so Exchange and Outlook get the message ([details](exchange-mirror.md#mail-sent-from-cmail-to-colleagues)). With the mirror off, delivery is local as before. | Exchange mirror |
| Admin > Mailboxes, Admin > People | A **domain picker** appears when there is more than one domain. A typed full address must be on one of them. | none |
| Delegates and the org chart | People whose personal mailbox is on any organisation domain can be delegates; work emails may use any of them. | none |
| Public directory ([manager handbook](manager-handbook.md)) | Public work emails on any organisation domain are listed. | Public directory |
| [Focused Inbox](focused-inbox.md) | A proven sender (DMARC pass at the trusted boundary, an Exchange-authenticated internal submission, or internal cmail mail) on any organisation domain counts as a colleague. | Focused Inbox |

## What does not change

- **Sending from other domains.** A mailbox on another discovered domain can
  be read, filed and delegated, but a send from it is refused with "Sending
  from @domain isn't set up yet". (A mailbox on a domain that was never
  discovered is left to the checks that applied before.) Sending needs that domain onboarded to
  Cloudflare Email Sending (a DNS change) and a verified test first; that is
  a later step. The Message-ID already follows the From domain.
- **Mail arriving by Cloudflare Email Routing** (cmail as the primary mail
  host) is for the domains whose MX points at cmail, as before.
- **Standby test address, probe and switch** work on `MAIL_DOMAIN` only.
- **Cloudflare Access auto-provisioning** (`ACCESS_AUTO_PROVISION`) still
  creates accounts for `MAIL_DOMAIN` emails only.
- **Welcome emails** are still sent from `MAIL_DOMAIN`, and go to each new
  person's Microsoft 365 primary address, whatever its domain.
- Nothing deletes mail or mailboxes. A domain that leaves the list keeps its
  mailboxes; they just stop being filed by the mirror and offered in Admin.

## Security

- **Only provably owned domains.** A domain enters the list only from
  `MAIL_DOMAIN` or Microsoft's own verified-domain answer for the configured
  tenant. A manager cannot add one, and request values are checked against
  the list on the server (a tampered domain picker is refused).
- **No cross-domain spoofing.** A user can send only from a mailbox they
  hold with Send as or Full access, and never from another discovered domain
  for now.
- **"Colleague" needs proof.** Focused Inbox treats a sender as internal only
  with a proven From, whatever the domain.
- **Fail closed.** If the list cannot be read, sends fail with the draft
  kept, Admin actions that create something fail, and pages that only show
  choices fall back to `MAIL_DOMAIN` alone (narrower, never wider).

## How to turn it on

There is no separate switch. With the Microsoft 365 sync already working:

1. In the Microsoft Entra admin center, open the sync app's **API
   permissions** and add **Microsoft Graph > Application permissions >
   `Domain.Read.All`**, the least privileged permission for listing domains
   ([permissions](https://learn.microsoft.com/en-us/graph/api/domain-list#permissions)).
   **Grant admin consent** and check it shows "Granted". This is a tenant
   change: get the owner's yes first.
2. In **Admin > Microsoft 365 sync**, turn **dry run** on, then press **Sync
   now**.
3. Within 15 minutes, check **Status > Mail domains** lists the domains you
   expect, and the dry run report shows the accounts and shared mailboxes it
   would create on them, with no unexpected pauses.
4. Turn dry run off. The next full reconciliation creates them. If the alias
   import and the Exchange mirror are on, aliases on the new domains follow
   on the next import, and journal reports for those mailboxes are filed.

## How to roll it back

- **Stop discovering:** remove `Domain.Read.All` from the sync app. The list
  is then frozen at its last value (Admin shows "can't be read").
- **Drop a domain:** remove it from the tenant; the next successful read
  removes it from the list (audited).
- **Back to `MAIL_DOMAIN` only:** with the permission removed, delete the
  `m365_verified_domains` row from `org_settings` in D1 (a production data
  change: owner's yes first). Accounts and mailboxes already created stay;
  pause or remove them in Admin if needed.

## Troubleshoot

| What you see | Why | What to do |
|---|---|---|
| Mail domains: "MAIL_DOMAIN only" and "can't be read: grant the sync app `Domain.Read.All`" | The app has no `Domain.Read.All`, or no admin consent | Step 1 of [How to turn it on](#how-to-turn-it-on) |
| A verified domain is missing | The read has not run since it was verified | Press **Sync now** |
| `*.onmicrosoft.com` is not listed | By design | Nothing |
| Mirror day shows `unmatched_domain` | A mailbox is on a domain no longer in the list | Check the tenant's domains; the mailbox's mail is still in Exchange |
| "Sending from @domain isn't set up yet" | Sending from other domains is not built yet | Send from a `MAIL_DOMAIN` address |
| A send to a colleague fails with the provider's setup message while the mirror is on | The mirror needs the outbound provider to reach Exchange | Set up [sending](sending.md), or turn the mirror off |

## Upgrade

No migration. The list lives in `org_settings`, which every instance has.
Until the sync app has `Domain.Read.All`, an instance behaves exactly as
before.

## Code and tests

- `packages/shared/src/org-domains.ts`: `orgDomains(env, db)`, the cache and
  its parsing.
- `apps/email-worker/src/m365-sync/domains.ts`: the daily read and the
  "never shrink on failure" rule; `graph.ts` `verifiedDomains()`.
- Uses: `m365-sync/classify.ts`, `aliases.ts`, `purpose.ts`, `sync.ts`;
  `exchange-mirror/ingest.ts`; `packages/shared/src/focused-inbox.ts`;
  `apps/web/src/lib/server/org-domains.ts`, `recipient-delivery.ts`,
  `mailbox-assignees.ts`, `public-directory.ts`, `focused-inbox.ts`; the
  compose, Admin mailboxes, People, org chart and assignee routes.
- Tests: `org-domains.test.ts`, `focused-inbox.test.ts` (shared);
  `m365-sync/domains.sql.node.test.ts`, `aliases.sql.node.test.ts`,
  `exchange-mirror.sql.node.test.ts` (Worker);
  `lib/server/multi-domain.test.ts`, `recipient-delivery.test.ts`,
  `mailbox-assignees.test.ts`, `admin/mailboxes/assignees/assignees.test.ts`
  (web).
