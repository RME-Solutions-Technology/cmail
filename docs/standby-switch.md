---
title: "Switch mail to the cmail standby, and back"
summary: "How to move a domain's incoming mail to cmail and back, one DNS change each, with scripts."
applies_to: standby
audience: [operator]
switch: none
last_reviewed: 2026-11-16
related: [standby-probe.md, copy-back.md, credentials.md]
---

# Switch mail to the cmail standby, and back

**In this article**

- [At 3am: state now, do this next](#at-3am-state-now-do-this-next)
- [Proven and not proven](#proven-and-not-proven)
- [How it works](#how-it-works)
- [First-time setup and drill](#first-time-setup-and-drill)
- [Pre-flight checklist (before every switch)](#pre-flight-checklist-before-every-switch)
- [How to switch over](#how-to-switch-over)
- [How to verify mail is arriving](#how-to-verify-mail-is-arriving)
- [How to switch back](#how-to-switch-back)
- [What it cannot do](#what-it-cannot-do)
- [Troubleshoot: when a script refuses](#troubleshoot-when-a-script-refuses)
- [Code and tests](#code-and-tests)
- [Sources](#sources)

## At 3am: state now, do this next

| You see | Mail goes to | Do this next |
|---|---|---|
| `dig +short MX <domain> @1.1.1.1` lists the old provider (for example `*.mail.protection.outlook.com`) | The old provider | Provider down? [Pre-flight](#pre-flight-checklist-before-every-switch), then [How to switch over](#how-to-switch-over). Not down? Nothing. |
| It lists `*.mx.cloudflare.net` | cmail | Provider back? [How to switch back](#how-to-switch-back) with the **apply** snapshot. Not back? Watch [Verify](#how-to-verify-mail-is-arriving). |
| A mix of both | Either, unpredictably | Run the switch-back **dry run** with the apply snapshot and follow what it says; it never changes anything without `--apply`. |
| A script ended with exit code 2, 3 or 4 | Unknown until checked | Read its last lines: they print the snapshot path and the exact command. See [Exit codes](#exit-codes). |

Always: **dry run first, owner's yes, then `--apply`**, run by a person at a
terminal. The apply snapshot is the file the switch printed as "Rollback
snapshot saved and checked" (`standby-snapshots/<domain>-<time>-switch-apply.json`).

---

When Exchange Online (or another mail provider) stops receiving, cmail can
take the domain's incoming mail: the domain's MX records are pointed at
Cloudflare Email Routing, whose catch-all hands every message to the cmail
email Worker. When the provider is back, the MX records are restored and the
mail that arrived meanwhile can be copied back
([Copy standby mail back into Exchange](copy-back.md)).

Two scripts do the DNS part, each in one change:

- `scripts/standby/switch.mjs` points the apex MX at Cloudflare.
- `scripts/standby/switch-back.mjs` restores the original MX from the
  snapshot the switch saved.

> **Status:** built, **not yet run against a real Cloudflare zone.** The
> scripts are tested only against a mocked Cloudflare API. Part of the design
> rests on Cloudflare behaviour that is not documented (see
> [Proven and not proven](#proven-and-not-proven)). The
> [First-time setup and drill](#first-time-setup-and-drill), a full switch and
> switch-back in a quiet window, must pass before the standby is relied on.
> **The apply path must never be used for the first time in an outage.**

> **DNS changes are always run by a person, after the owner's yes.** Both
> scripts are dry runs unless `--apply` is given, and `--apply` also needs the
> domain typed at an interactive terminal. They refuse `--apply` when `CI` is
> set and when input is piped. Never automate them.

## Proven and not proven

| What the design relies on | Source | Status |
|---|---|---|
| Email Routing needs **exclusive control of the root domain's MX records**: onboarding a domain that has another provider's MX fails with error 2008, "Non-Cloudflare MX records exist". | Cloudflare [Troubleshooting](https://developers.cloudflare.com/email-service/reference/troubleshooting/), [Domains](https://developers.cloudflare.com/email-service/configuration/domains/#move-to-email-routing-from-another-provider) | Documented |
| Cloudflare's way in from another provider: delete that provider's MX, enable Email Routing (Cloudflare adds its MX and a `cf2024-1._domainkey` DKIM record; SPF only if none exists), then create routing rules at once, because with Cloudflare's MX in place **mail to an address with no rule is rejected ("Address does not exist") and the sender does not retry**. Senders mostly retry the brief no-MX gap; resolvers that cached the absence may take up to 30 minutes. | [Domains: Move to Email Routing](https://developers.cloudflare.com/email-service/configuration/domains/#move-to-email-routing-from-another-provider) | Documented |
| Email Routing's root records (MX, SPF, DKIM) can be **unlocked** and edited to point to another provider. An edited record stays associated with Email Routing and is deleted if Email Routing is disabled. Onboarding locks the records it creates. | [Domains: Locked DNS records](https://developers.cloudflare.com/email-service/configuration/domains/#locked-dns-records), [Remove a domain from Email Routing](https://developers.cloudflare.com/email-service/configuration/domains/#remove-a-domain-from-email-routing) | Documented |
| Subdomain routing (the [standby address](standby-probe.md) `name@standby.<domain>`) is added from the **apex domain's** Email Routing Settings, with literal rules only; the catch-all exists only on the apex. | [Subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/) | Documented |
| A DNS batch (`POST /zones/{id}/dns_records/batch`) runs deletes, patches, puts, posts in **one database transaction: all or nothing**. Propagation to Cloudflare's edge is per record, not atomic. | [Batch record changes](https://developers.cloudflare.com/dns/manage-dns-records/how-to/batch-record-changes/) | Documented |
| `GET /zones/{id}/email/routing` gives `enabled` and `status` (`ready`, `unconfigured`, `misconfigured`, `misconfigured/locked`, `unlocked`); `GET .../email/routing/dns` lists the DNS records Email Routing needs; `PATCH .../email/routing/dns` unlocks them; `GET .../email/routing/rules/catch_all` reads the catch-all. Zones and routing rules list at most 50 per page. | [Email Routing API](https://developers.cloudflare.com/api/resources/email_routing/), [Zones](https://developers.cloudflare.com/api/resources/zones/methods/list/) | Documented |
| **The prepared state: Email Routing enabled on the zone, root MX unlocked and pointing at Exchange, the standby subdomain still routing to cmail.** | none | **Not proven until the drill passes** (drill step 9). Cloudflare documents unlocking only as a step on the way out. |
| **That MX records the switch creates through the DNS API** (the `*.mx.cloudflare.net` hosts and priorities Cloudflare lists) **make Email Routing accept apex mail again**, without calling Cloudflare's Enable. | none | **Not proven until the drill passes** (drill step 11). |
| What `GET .../email/routing/dns` returns while the apex points elsewhere. If it lists no MX, the switch stops and asks for `--cloudflare-mx` (copied from Email Routing > Settings). | none | Not proven; the drill shows which |
| What `PATCH .../email/routing/dns` answers when nothing is locked. The switch-back tolerates a refusal and goes on (a still-locked record makes the batch refuse cleanly). | none | Not proven |
| Whether Email Routing needs `include:_spf.mx.cloudflare.net` when it only delivers to a Worker (Cloudflare says the record authorises it to forward). The switch leaves SPF alone unless `--spf-include`. | [Domains: Routing records](https://developers.cloudflare.com/email-service/configuration/domains/#routing-records) | Not proven either way |
| The probe reading needs the standby probe's tables (migration `0023`, [standby test address and probe](standby-probe.md)). | this repo | Needs that feature deployed and switched on |

When the drill has passed on a real domain, record the date and what was
seen in the instance's own notes, and change the two bold rows to "Proven
(drill on <date>)".

The headline case people ask about, "apex MX at Exchange, standby on a
subdomain", is therefore the **unproven** part. At switch time the script
replaces the apex MX with exactly the records Cloudflare lists, with the
catch-all already in place, which is what Cloudflare documents for moving to
Email Routing.

## How it works

```mermaid
stateDiagram-v2
  direction LR
  Normal: Normal\napex MX = Exchange\nEmail Routing on, root records unlocked\ncatch-all = cmail Worker\nstandby subdomain + daily probe
  Standby: Standby\napex MX = Cloudflare\nall mail to cmail
  Normal --> Standby: switch.mjs --apply\n(one DNS batch)
  Standby --> Normal: switch-back.mjs --apply\n(unlock if locked, one DNS batch)
```

**switch.mjs** reads, then checks, then (only with `--apply` and the typed
domain) changes:

1. The zone: exactly one Cloudflare zone named `--domain`, type `full` (DNS
   hosted on Cloudflare), `active`. A subdomain or a partial (CNAME) or
   secondary zone is refused.
2. Email Routing: `enabled` with status `unlocked`, `misconfigured` or
   `ready`. Not enabled is refused with a pointer to
   [First-time setup](#first-time-setup-and-drill) (Cloudflare would refuse
   with 2008); `misconfigured/locked` is refused (unlock first).
3. The catch-all: enabled, matcher `all`, a single action `worker` to exactly
   `--worker`. Otherwise refused. Literal apex rules that send elsewhere are
   listed as warnings (they take those addresses first).
4. The probe: with `--probe-d1 <database-id>` it reads the standby probe light
   from D1 (two SELECTs, read-only; see [standby probe](standby-probe.md)) and refuses anything but **green** (the
   same rules as Admin > Standby test). An unreadable probe is refused unless
   `--skip-probe-check`. `--apply` without `--probe-d1` needs
   `--skip-probe-check`, which is printed loudly. `--skip-probe-check` never
   overrides a probe that reads amber or red.
5. The apex MX: at least one, none proxied, none already Cloudflare's (all
   Cloudflare's means "already switched, nothing to do"; a mix is refused).
   Every MX TTL must be at most `--max-ttl` (default 300 s; Auto counts as
   300 s); if not, it prints how to lower them and stops.
6. The target: the MX records Cloudflare lists in Email Routing's DNS
   settings for the apex, each a `*.mx.cloudflare.net` host with a priority.
   `--cloudflare-mx host:priority,...` is accepted only when Cloudflare lists
   none, and must also be `*.mx.cloudflare.net`.
7. SPF: **left exactly as it is by default.** Only with `--spf-include` does
   the one apex SPF record gain `include:_spf.mx.cloudflare.net` right after
   `v=spf1`, keeping every existing term. That edit is refused if there are
   two SPF records, if the record is split into several strings, or if the
   top-level lookups would exceed 10, and warns from 6 top-level lookups
   (nested includes are not resolved, so check the full count with an SPF
   checker). With no SPF record it creates none.

It prints the records now, the **change set**, the **reverse change set**
and warnings. A dry run (or a refused `--apply`) saves a **dry-run
snapshot**. With `--apply` it then asks for the domain to be typed, re-reads
the MX and SPF records and stops if they changed while it waited, writes the
**apply snapshot**, reads it back and checks that switch-back would accept it
and restore the original MX (refusing and removing it if not), and only then
sends **one DNS batch** (delete the old MX, edit SPF if `--spf-include`, add
Cloudflare's MX with Auto TTL and the comment `cmail standby switch <time>`).
It re-reads (retrying up to four times) and compares.

**switch-back.mjs** checks the snapshot (format, SHA-256 checksum, written by
the switch, same domain, same zone id, and kind `apply` unless
`--allow-dry-run-snapshot`), reads the zone, and plans: delete the apex MX
records that are Cloudflare's, re-create every original MX with its host,
priority, TTL and comment (tags and record ids are recorded in the snapshot
but not restored), and put SPF back **only if it still holds what the switch
wrote** (an SPF record edited since is left alone, with a warning). It
then compares the apex SPF it expects to leave with the snapshot's original
and, on any difference (for example the SPF record Cloudflare's onboarding
adds when none existed), warns and prints the exact record to delete or the
exact content to restore by hand. Any apex
MX that is neither Cloudflare's nor in the snapshot stops it. If Email
Routing's status says its records are locked (`ready` or
`misconfigured/locked`), it first unlocks them (`PATCH .../email/routing/dns`,
Cloudflare's documented step before pointing MX elsewhere); a refused unlock
is reported and it goes on, because a record that is still locked only makes
the batch refuse cleanly. `--skip-unlock` skips the call (after unlocking by
hand in the dashboard). Then one DNS batch, then it re-reads and compares. It
never touches routing rules, the catch-all, the standby subdomain, or Email
Routing itself: the catch-all keeps sending to cmail, so senders that cached
Cloudflare's MX are still delivered.

### Exit codes

Both scripts use the same codes. **Exit code 1 always means nothing was
changed.** Once a script has sent a write (the unlock or the batch), any
error after that, even an unexpected one, ends with code 3, never 1.

| Code | Meaning | Do |
|---|---|---|
| 0 | Done, or nothing to do. Dry runs end here. | Verify. |
| 1 | Nothing was changed: refused before any write, the confirmation did not match, or Cloudflare refused the batch (one transaction, so none of it applied). | Read the reason, fix, run the dry run again. |
| 2 | The batch was applied, but the records read back differ from the plan. | Check DNS > Records now; the output prints the undo command. |
| 3 | **Outcome unknown**: the batch call timed out or failed without a clear answer, or the records could not be read back afterwards. The script re-reads and says whether it looks applied. | Check DNS > Records now. Run the printed switch-back command, dry run first: it is safe in either state (it does nothing if already restored). |
| 4 | switch-back only: Email Routing's records were unlocked, then Cloudflare refused the batch. The MX are unchanged; the unlock is the only change. | Fix the cause and run switch-back again. |

### What changes and what is left alone

| Record | Switch | Switch-back |
|---|---|---|
| Apex MX | Old provider's deleted, Cloudflare's added (one batch) | Cloudflare's deleted, originals re-created (one batch) |
| Apex SPF | Untouched, unless `--spf-include` | Restored, only if the switch edited it and it is unchanged since |
| DKIM (Exchange `selector1`/`selector2` CNAMEs, Cloudflare `cf2024-1`) | Untouched | Untouched |
| DMARC (`_dmarc`) | Untouched | Untouched |
| Standby subdomain MX, routing rules, catch-all | Untouched (checked) | Untouched |
| Everything else (web, autodiscover, verification records) | Untouched | Untouched |

**Exchange outbound is unaffected by default.** Outbound mail does not use
the MX records. It relies on SPF, DKIM and DMARC, which the switch leaves
exactly as they are unless you ask for `--spf-include` (which only adds a
term). So people can still send from Outlook if Exchange itself is up. The
switch warns if the SPF record does not include `spf.protection.outlook.com`.
cmail's own sending goes through Cloudflare Email Sending on the `cf-bounce`
subdomain ([sending](sending.md)) and is not affected by the switch.

### Snapshots

`standby-snapshots/<domain>-<UTC time>-switch-<dry-run|apply>.json` (change
the folder with `--snapshot-dir`). It holds the apex MX, SPF, DMARC, DKIM and
standby-subdomain records as read (content, priority, TTL, proxied, comment
and tags), Email Routing's status, any SPF edit, the Cloudflare MX used, and
a SHA-256 checksum. The apply snapshot is written only after the typed
confirmation, and is read back and checked before anything changes. After
the batch, a `.result.json` beside it records whether it applied and the
records afterwards. Switch-back `--apply` writes its own
`...-switch-back-apply.json` (the records before it ran; it cannot be used as
a switch-back source). Files are never overwritten and are created with mode
0600, which only POSIX systems honour: on Windows the file gets the folder's
permissions, so keep the folder in a private location.
**They contain the domain's real DNS data: keep them private and out of git**
(`standby-snapshots/` is in `.gitignore`). Keep the apply snapshot until the
switch-back is done and verified.

### Token permissions

The scripts read `CLOUDFLARE_API_TOKEN` from the environment and never print
it (error text is scrubbed, requests go only to
`https://api.cloudflare.com/client/v4/`, redirects are refused). Use a token
scoped to the one zone (and the one account for D1):

| Permission | Used for |
|---|---|
| Zone > Zone > Read | finding the zone |
| Zone > DNS > Read | reading records (dry runs) |
| Zone > Zone Settings > Read | Email Routing settings and its DNS list |
| Zone > Email Routing Rules > Read | catch-all and rules |
| Account > D1 > Read | the probe (only with `--probe-d1`; also set `CLOUDFLARE_ACCOUNT_ID`) |
| Zone > DNS > Edit | `--apply` (the batch) |
| Zone > Zone Settings > Edit | switch-back `--apply` when records must be unlocked |

The dashboard calls the write level **Edit**; the API reference calls it
Write. All of cmail's credentials are listed in
[Credentials and permissions](credentials.md).

A read-only token is enough for every dry run. Give the write permissions
only to the people who may change DNS, and set the token for the session only:

```sh
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN   # paste, Enter
export CLOUDFLARE_ACCOUNT_ID=<account id>                        # for --probe-d1
```

```powershell
$env:CLOUDFLARE_API_TOKEN = Read-Host -MaskInput 'Cloudflare token'
$env:CLOUDFLARE_ACCOUNT_ID = '<account id>'
```

## First-time setup and drill

Onboarding a Microsoft 365 organisation end to end? See [the onboarding guide](onboarding-microsoft-365.md#12-standby-test-switch-and-copy-back-optional), step 12.

Once per domain, before the standby can be relied on. It sets up Email
Routing, then runs a **full cycle with the scripts**: switch-back, switch
`--apply`, an outside test message into cmail, switch-back `--apply`. **Needs
the owner's yes and a quiet window** (the quietest hour of the week; allow
one hour). Two people: one runs it, one sends test mail and watches. If any
step fails, stop and switch back.

### Exposure, quantified

| Moment | What happens to mail sent then | How long |
|---|---|---|
| Steps 4 to 5: no MX at the apex | Most senders defer and retry later. RFC 5321 lets a sender fall back to the apex A/AAAA record (often the website), which normally refuses SMTP: also a deferral. Resolvers that cached "no MX" may take up to 30 minutes to see the new records (Cloudflare's guidance). | Seconds, if step 5 follows at once |
| Steps 5 to 6: Cloudflare MX, no catch-all yet | **Rejected permanently** ("Address does not exist"); the sender gets a bounce and does not retry. | Aim for under 30 seconds |
| Steps 5 to 10: Cloudflare MX with the catch-all | Delivered into cmail (for people who have a mailbox; others get cmail's neutral reject). Copy-back can move it to Exchange. | Minutes |

Before the window, find the domain's typical inbound rate in Exchange
(Exchange admin center > Mail flow > Message trace, the same hour last week).
Messages at risk of a permanent bounce are roughly that rate per minute times
the minutes between steps 5 and 6; at tens of messages an hour and 30
seconds, expect none or one. To keep it that short: prepare step 6 before
step 4 (Routing rules page open in a second tab, the Worker chosen), and do
steps 4, 5 and 6 back to back. **First try step 6 before step 4**: if the
dashboard lets you save the catch-all before onboarding, that window is zero;
note whether it did.

### Before the window

1. The domain's DNS is on Cloudflare (full setup). cmail is deployed for
   `MAIL_DOMAIN`, every person has a cmail mailbox
   ([Microsoft 365 mailbox sync](m365-sync.md)) and can sign in
   ([staff sign-in](staff-sign-in.md)). The [standby probe](standby-probe.md)
   is deployed and switched on.
2. Lower the apex MX TTL to Auto (300 s) and wait out the old TTL (days ahead
   is best).
3. Take the snapshot of the original records with a dry run. It is refused
   ("Email Routing is not enabled") but saves `...-switch-dry-run.json`;
   keep it. Add `--spf-include` only if you will add the SPF include by hand
   in step 5, so the switch-back can remove it again. It is removed only if
   the record then reads **exactly** as this dry run printed it (the include
   right after `v=spf1`, every other character the same); anything else is
   left alone and switch-back prints the original record to restore by hand.
   ```sh
   node scripts/standby/switch.mjs --domain example.com --worker <email-worker-name>
   ```

### In the window: onboard Email Routing (dashboard)

Following Cloudflare's
[Move to Email Routing](https://developers.cloudflare.com/email-service/configuration/domains/#move-to-email-routing-from-another-provider):

4. DNS > Records: delete the old provider's apex MX records.
5. At once: Compute > Email Service > Email Routing > Onboard Domain: choose
   the domain. Cloudflare adds its MX (locked) and the `cf2024-1` DKIM record.
   Leave SPF alone unless you chose `--spf-include` in step 3.
6. At once: Routing rules > Catch-all address > Send to a Worker > the cmail
   email Worker, enabled.
7. Settings > Subdomains: add `standby.<domain>` and the probe's literal rule
   ([standby probe](standby-probe.md)).
8. Send a test from an outside mailbox (another provider) to a real person;
   it should appear in cmail.

### In the window: back to the old provider, then the full scripted cycle

9. Put mail back on the old provider from the step 3 snapshot (dry run, then
   apply). This unlocks Email Routing's root records and restores the
   original MX:
   ```sh
   node scripts/standby/switch-back.mjs --domain example.com --snapshot standby-snapshots/<file>-switch-dry-run.json --allow-dry-run-snapshot
   node scripts/standby/switch-back.mjs --domain example.com --snapshot standby-snapshots/<file>-switch-dry-run.json --allow-dry-run-snapshot --apply
   ```
   Then check the **prepared state**: an outside test reaches Exchange, and
   Admin > Standby test > Run test now goes green (the standby subdomain still
   receives while the apex points to Exchange). If the probe cannot go green,
   the prepared state does not work on Cloudflare as it stands: stop here,
   leave mail on the old provider, and rethink before relying on the standby.
10. Switch dry run: every check must pass (Email Routing status, catch-all,
    TTL, probe GREEN). Note the Email Routing status it shows.
11. **Switch for real**, exactly as in an outage ([How to switch over](#how-to-switch-over), steps 2
    and 4), then [How to verify mail is arriving](#how-to-verify-mail-is-arriving): an
    outside test message must appear in cmail and in Email Routing >
    Activity as delivered to the Worker. This proves the apply path.
12. **Switch back for real** with the apply snapshot from step 11
    ([How to switch back](#how-to-switch-back)), and verify an outside test reaches
    Exchange.
13. Copy back any real mail that arrived in cmail during the window
    ([copy-back](copy-back.md)).

After the window, record what you saw (this is the evidence the design
lacks): Email Routing's status at each step, whether the catch-all could be
saved before onboarding, the exit codes, and the test results. Then update
the two bold rows in [Proven and not proven](#proven-and-not-proven). Repeat
steps 10 to 12 as a drill after any change to Email Routing, the Worker or
DNS, and at least twice a year.

## Pre-flight checklist (before every switch)

- [ ] **The drill has passed** on this domain ([First-time setup and drill](#first-time-setup-and-drill)).
- [ ] **The owner's yes** to switch this domain now, given after reading the
      dry-run output.
- [ ] **Who can change DNS** is known and reachable: the person running the
      script has a token with the write permissions above, and a second person
      knows the switch is happening. The list of these people lives with the
      instance's own records, not in this repo.
- [ ] **TTL lowered:** the dry run shows every apex MX at 300 s or Auto, set
      at least the old TTL ago.
- [ ] **Probe green:** Admin > Standby test is green and the dry run with
      `--probe-d1` says GREEN.
- [ ] **Sign-in tested:** someone signed in to cmail today the way staff will
      (Access, and passkeys if Entra is down). If Entra is down, check that
      the people who need mail have a working session or passkey.
- [ ] **Mailboxes exist:** Admin > Microsoft 365 sync ran recently without a
      held change; new starters have mailboxes.
- [ ] **Routing ready:** the dry run shows the catch-all sending to the
      Worker and no warnings about literal rules or the standby subdomain.
- [ ] The snapshot folder is private and has room.
- [ ] People know to read mail in cmail for now (a message from a channel
      that does not depend on the failed mail system).

## How to switch over

1. Set the token for this session (see [Token permissions](#token-permissions)).
2. Dry run, and read all of it:
   ```sh
   node scripts/standby/switch.mjs --domain example.com --worker <email-worker-name> --probe-d1 <d1-database-id>
   ```
3. Send the change set to the owner and wait for the yes.
4. Apply, and type the domain when asked:
   ```sh
   node scripts/standby/switch.mjs --domain example.com --worker <email-worker-name> --probe-d1 <d1-database-id> --apply
   ```
5. Note the time and the path it printed as "Rollback snapshot saved and
   checked". You need both to switch back and to copy mail back. Check the
   exit code against [Exit codes](#exit-codes).

## How to verify mail is arriving

1. `dig +short MX example.com @1.1.1.1` and `@8.8.8.8` list the Cloudflare
   hosts. Other resolvers may give the old answer until the old TTL passes.
2. Send from an outside mailbox (another provider) to a real person: the
   message appears in cmail within a minute or two and in Admin > Mail trace.
3. Cloudflare dashboard > Email Routing > Activity shows the message
   delivered to the Worker ("Handled"), not dropped or rejected.
4. Admin > Standby test: Run test now stays green.
5. If Exchange is still up for sending: send from Outlook to an outside
   mailbox and check the received headers show SPF, DKIM and DMARC pass.

If mail is rejected or not arriving: check the catch-all in the dashboard,
then Activity for the reason, then [receiving](receiving.md). If in doubt,
switch back.

## How to switch back

1. When the provider receives again (check its service health), dry run with
   the **apply** snapshot:
   ```sh
   node scripts/standby/switch-back.mjs --domain example.com --snapshot standby-snapshots/<file>-switch-apply.json
   ```
2. The owner's yes, then the same with `--apply`, typing the domain.
3. Verify: `dig +short MX example.com @1.1.1.1` shows the original hosts; an
   outside test message reaches Exchange (Outlook); Admin > Standby test is
   still green (the standby address keeps working for next time).
4. Mail that arrived in cmail meanwhile:
   - It stays in cmail; nothing is moved or deleted, and people can keep
     reading it there.
   - Senders with the Cloudflare MX cached, and retries, keep arriving in
     cmail for a while (up to the MX TTL, longer for retries). The catch-all
     still sends to the Worker, so these are not lost.
   - Copy it into Exchange with Admin > Copy back to Exchange
     ([copy-back](copy-back.md)). Use the window the script prints: from the
     switch to one hour after the switch-back (UTC), and start it after that
     hour. Messages Exchange already has are skipped by Message-ID, so a wide
     window is safe; run a second job later if stragglers arrive.

## What it cannot do

- **Mail Microsoft already accepted stays with Microsoft.** Messages
  Exchange Online Protection accepted or queued before the switch are
  delivered by Microsoft when Exchange recovers; they never reach cmail.
- **Internal mail does not use MX.** Mail between people in the same
  Microsoft 365 tenant is delivered inside Exchange and is not redirected.
- **Cloudflare filters differently from Exchange, so some mail Exchange
  would accept bounces while switched.** Email Routing rejects mail that
  passes neither SPF nor DKIM, mail that fails the sender's DMARC policy
  (`p=reject`), mail from IPs on its real-time block lists, and messages over
  its inbound size limit (25 MiB); cmail then applies its own limits
  ([receiving](receiving.md), 10 MiB by default). Senders get a bounce;
  these messages are not queued anywhere
  ([Postmaster](https://developers.cloudflare.com/email-service/reference/postmaster/),
  [Email lifecycle](https://developers.cloudflare.com/email-service/concepts/email-lifecycle/),
  [Limits](https://developers.cloudflare.com/email-service/platform/limits/)).
- **Senders that cached the MX.** Until the old TTL passes (300 s if you
  lowered it; some resolvers keep answers longer), some senders still deliver
  to the old provider after the switch, and to cmail after the switch-back.
- **Timing is not instant.** Cloudflare applies the batch in one
  transaction, but its edge picks the records up one by one, and senders
  retry deferred mail on their own schedules (minutes to days).
- **Not a first-time setup.** It does not enable Email Routing, create the
  catch-all, or add the standby subdomain; see
  [First-time setup and drill](#first-time-setup-and-drill).
- **Apex domains on Cloudflare DNS only**, one domain per run. A domain with
  several mail domains needs a run per domain.
- **It bypasses a mail gateway.** If the apex MX point at a filtering
  gateway rather than Exchange, the switch replaces the gateway too, and
  switch-back restores it.
- **It does not restore record tags or ids**, only each MX record's host,
  priority, TTL and comment.
- **It does not check sign-in, sending, or the mail itself**; the checklist
  and the verify steps do.

## Troubleshoot: when a script refuses

| It says | Do |
|---|---|
| `No Cloudflare zone named ...`, `not "full"` | The domain's DNS is not on Cloudflare, or you passed a subdomain. |
| `Email Routing is not enabled` | [First-time setup and drill](#first-time-setup-and-drill). |
| `misconfigured/locked` | Email Routing > Settings > DNS records > Unlock. |
| `catch-all rule must be enabled and send to Worker` | Routing rules > Catch-all address > Send to a Worker. |
| `TTL above ...` | Lower the TTL as printed and wait out the old one. |
| `probe is red/amber/off` | Admin > Standby test: fix the reason, Run test now. |
| `Could not read the standby probe` | Check `CLOUDFLARE_ACCOUNT_ID`, the D1 id and the token's D1 Read; or check Admin yourself and pass `--skip-probe-check`. |
| `listed no Email Routing MX records` | Copy the MX from Email Routing > Settings and pass `--cloudflare-mx`. |
| SPF refusals (only with `--spf-include`) | Fix SPF by hand, or leave out `--spf-include`. |
| `half-switched`, `neither Cloudflare's nor in the snapshot` | Someone changed DNS. Compare the zone with the snapshot by hand. |
| `changed since they were read` | Run the dry run again. |
| `This is a dry-run snapshot` | Use the apply snapshot; `--allow-dry-run-snapshot` is for First-time setup only. |
| `rollback snapshot failed its check` | Nothing changed. Check the snapshot folder (disk, permissions) and run again. |
| `Unlock was refused` | Informational: it went on. If the batch is then refused, unlock in the dashboard and run with `--skip-unlock`. |

## Code and tests

- `scripts/standby/switch.mjs`, `scripts/standby/switch-back.mjs` (entry
  points, `--help`), `scripts/standby/lib/` (`cloudflare.mjs` API client,
  `mail-dns.mjs` checks and change sets, `probe.mjs` probe light,
  `snapshot.mjs`, `cli.mjs` including the exit codes).
- Tests: `scripts/standby/test/` against an in-memory Cloudflare API (no
  network) that enforces the documented page-size limits and refuses an
  unlock when nothing is locked: dry runs make no writes, every refusal, the
  typed confirmation, no apply snapshot before it, CI refusal, token
  redaction, SPF edge cases, a refused batch (exit 1), lost answers before
  and after commit and failed read-backs (exit 3), unlock then refusal
  (exit 4), a full switch and switch-back round trip, a tampered snapshot,
  and the First-time setup sequence. Run `pnpm test:standby-scripts`; it is
  part of `pnpm validate`.
- No migration, no Worker or web app change.

## Sources

- Cloudflare: [Domains](https://developers.cloudflare.com/email-service/configuration/domains/)
  (move from another provider, routing records, locked records, disabling),
  [Subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/),
  [Troubleshooting](https://developers.cloudflare.com/email-service/reference/troubleshooting/)
  (error 2008),
  [Postmaster](https://developers.cloudflare.com/email-service/reference/postmaster/)
  (MX hosts, SPF, authentication requirement, DMARC, block lists),
  [Email lifecycle](https://developers.cloudflare.com/email-service/concepts/email-lifecycle/),
  [Batch record changes](https://developers.cloudflare.com/dns/manage-dns-records/how-to/batch-record-changes/),
  API reference for [Email Routing](https://developers.cloudflare.com/api/resources/email_routing/),
  [DNS records](https://developers.cloudflare.com/api/resources/dns/subresources/records/),
  [Zones](https://developers.cloudflare.com/api/resources/zones/methods/list/) and
  [D1 query](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/),
  [TTL](https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/)
  (Auto is 300 seconds).
- RFC 7208 (SPF), section 4.6.4: at most 10 DNS-querying terms. RFC 5321,
  section 5.1: a domain with no MX falls back to its address records.
