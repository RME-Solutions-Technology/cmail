# Standby test address and daily probe

Status: **built, off by default, not yet tested against real DNS or a real
Cloudflare account.** The code paths are covered by tests with a mocked
Email Sending binding and a simulated Email Routing delivery (see
[How to test](#how-to-test)).

When cmail is kept as a standby for another mail system (for example Exchange
Online), the main domain's MX records point at the other system, so nothing
proves day to day that cmail would receive mail if you switched. This feature
gives every mailbox a second address on a subdomain whose MX already points at
Cloudflare, and sends a test message through it once a day.

- **Standby address.** `name@standby.example.com` delivers into the same
  mailbox as `name@example.com`. People can give it out during an outage, or
  you can send to it to check a mailbox by hand.
- **Daily probe.** Once a day the email Worker sends one message through
  Cloudflare Email Sending to its own system mailbox's standby address and
  checks that it arrives. Admin > Standby test shows a green, amber or red
  light, the last result, the last 7 days and the exact failure reason, and
  has a **Run test now** button.

## Architecture

```
 cron */10 (email Worker)            Cloudflare                    email Worker email()
 ──────────────────────────          ─────────────────────         ──────────────────────────────
 switch on? config ok? lease          Email Sending                 exact address? no
 time out overdue probes      ──▶    (from probe@example.com) ──▶  standby address? yes ─▶ probe mailbox
 prune old probes                     public MX of                  probe token known and live?
 daily probe due? ─ send ─────────▶   standby.example.com           store via the normal path
   insert run (waiting)               Email Routing literal rule    record pass + round trip
                                      ─▶ this Worker
```

| Part | Where |
|---|---|
| Switch, config, alias mapping, status light | `packages/shared/src/standby.ts` |
| Alias lookup, probe send, receipt, timeout, pruning | `apps/email-worker/src/standby/standby.ts` |
| Inbound wiring (alias, probe gate, receipt) | `apps/email-worker/src/index.ts`, `email()` |
| Private endpoints | `GET /internal/standby/config`, `POST /internal/standby/run` on `cmail-email-worker.internal` (service binding only) |
| Admin page | `apps/web/src/routes/admin/standby/`, `apps/web/src/lib/server/standby-admin.ts` |
| Tables | `standby_probe_runs`, `standby_probe_state` (migration `0023`) |

### The standby address

The inbound handler first looks up the exact recipient as before. Only if
that finds no active mailbox does it try the standby mapping:

1. The recipient's domain must equal `<STANDBY_SUBDOMAIN_LABEL>.<MAIL_DOMAIN>`
   exactly. Deeper subdomains (`a@x.standby.example.com`) and look-alikes are
   not mapped.
2. The local part is kept and the domain replaced by `MAIL_DOMAIN`.
3. One query requires, together: the manager switch is on; a mailbox exists at
   that primary address with status `active`; and it is a shared mailbox or a
   personal mailbox whose owner is `active` or `pending`. Paused and
   offboarded owners, disabled mailboxes and legacy personal mailboxes with no
   recorded owner are refused.

Anything that does not match gets the same neutral permanent refusal as an
unknown address on the primary domain, and nothing is written to D1 for it.

What this means for safety:

- **No open relay.** The alias only stores mail into existing cmail
  mailboxes. It never forwards, redirects or sends anything.
- **No catch-all.** An unknown local part is refused; nothing is created.
- **Paused and offboarded people.** Refused on the standby address. (The
  primary address behaves as before.)
- **Same rules as the primary address.** After the mailbox is found, the
  message goes through the unchanged pipeline: size, attachment and body
  limits, inbound rate and quota guards, SPF/DKIM/DMARC recording from the
  trusted `Authentication-Results` header, the organisation sender
  allow/block list, spam-score quarantine, inbox rules (which see the
  mailbox's primary address as "my address"), duplicate suppression by
  Message-ID (so the same message sent to both addresses is stored once) and
  mail trace (which records the standby address it was sent to).
- **Switch off.** With the switch off (the default), the standby domain is
  refused completely.

Plus addressing (`name+tag@...`) is not mapped, in the same way the primary
domain looks up exact addresses only.

### The probe

- **Dedicated system mailbox.** On the first probe the Worker creates a shared
  mailbox `cmail-standby-probe@<MAIL_DOMAIN>` ("Standby probe (system)") with
  nobody assigned, records its id in `standby_probe_state`, and writes an
  audit entry. If a mailbox already has that address and is not the recorded
  probe mailbox, the Worker never adopts it: the probe fails with
  `probe_address_in_use` and that mailbox's mail is untouched. Change
  `STANDBY_PROBE_LOCAL_PART` to use another address.
- **The probe mailbox takes only live probes.** Mail for it is stored only if
  it arrived on the standby address and carries the token of a probe that is
  still waiting. Everything else for that mailbox (on either address) is
  refused like an unknown address, so it cannot collect spam or real mail.
- **Token.** Each probe has 32 random bytes (base64url) in the
  `X-Cmail-Standby-Probe` header, and in the subject as a fallback. Only the
  SHA-256 of the token is stored. A probe is matched by token, never by
  sender, which anyone can forge.
- **Send path.** The Worker's native `EMAIL` binding (Cloudflare Email
  Sending) sends from the probe mailbox's primary address to its standby
  address. The message leaves Cloudflare's outbound service and comes back
  through the standby subdomain's MX and Email Routing, like any outside
  message. There is no internal shortcut, which is the point: a shortcut
  would test nothing that matters in an outage.
- **Receipt.** After the message is stored, the handler marks the run
  `pass` with the round trip (from the start of the send to storage), the
  folder it was filed to and the recorded SPF/DKIM/DMARC. The update only
  applies while the run is still waiting, so a duplicate never changes a
  result.
- **Timeout.** A run still waiting after `STANDBY_PROBE_TIMEOUT_MINUTES`
  (default 10) becomes `fail` / `timeout` on the next cron run, or on Run test
  now. Admin shows an overdue run as red straight away. A probe that arrives
  after its timeout is recorded as `late` (with how late) and not stored.
- **One at a time.** `in_flight` is a UNIQUE column that is 1 only while a
  probe is sending or waiting, and the cron takes a 60-second lease, so two
  runs never send two probes. Run test now is limited to one start a minute.
- **Schedule.** The cron runs every 10 minutes; the daily probe starts once
  23 h 50 min have passed since the last scheduled one (the slack stops the
  start time drifting later each day). It also times out overdue probes and
  prunes.
- **Pruning.** Probe messages are deleted from the probe mailbox (D1 row and
  R2 body and attachments) after 7 days; results after 30 days. Only messages
  that a probe run recorded, in the probe mailbox, are ever selected, so no
  other mail can be reached by this code. Nothing is pruned while the switch
  is off.
- **Logs** carry outcome codes only, never addresses or tokens.

### Status light

| Light | When |
|---|---|
| Off | The switch is off |
| Green | The newest finished test passed within the last 26 hours, with no warning that matters |
| Amber | It passed with a warning (filed to Spam, DMARC not `pass`, or slower than 5 minutes); the last pass is 26 to 50 hours old; or no test has finished yet |
| Red | The newest finished test failed (reason shown); a running test is overdue; or no pass for 50 hours |

"SPF, DKIM and DMARC were not recorded" (no `INBOUND_AUTHSERV_ID`) is shown
but does not make the light amber.

Failure reasons: `timeout`, `late`, `send_rejected` (with the Email Sending
error code, for example `E_SENDER_NOT_VERIFIED`), `send_failed` (an
ambiguous or network failure), `no_send_binding`, `probe_address_in_use`,
`probe_mailbox_disabled`, `probe_mailbox_missing`.

## What a green light means, and what it does NOT mean

Green means: within the last day, a message sent by Cloudflare Email Sending
to the standby address went out, came back in through the standby subdomain's
public MX and Email Routing, reached this email Worker, passed the same
inbound checks as any mail, and was stored in D1 and R2 within the time limit.

Green does **not** mean:

- that the **main domain** would deliver to cmail. Its MX normally points at
  the other mail system; switching it is a separate, manual DNS step.
- that **every person** is reachable on the standby address. Each address on
  the subdomain needs its own Email Routing rule (see Setup); the probe only
  proves the probe address's rule.
- that **outside senders** reach you. The probe is sent from Cloudflare's own
  network; another provider's outbound path, reputation checks or a blocklist
  are not tested.
- that **sending** to outside recipients works, or that people can **sign
  in** (Access, Entra) and read mail.
- that a **message to a person** would land in their Inbox: their own inbox
  rules and the sender list still apply.

Amber or red is a reason to look, not proof of an outage: one failed probe
can be a short Cloudflare delay. Run test now to check again.

## Setup

Do these in order. DNS and Email Routing changes are live changes; follow your
own change process.

1. **Migration.** Apply `0023` (`pnpm db:migrate`). Additive: two new tables.
2. **Email Worker settings** (`apps/email-worker/wrangler.toml`):
   - `MAIL_DOMAIN`: the same value as the web app's.
   - `STANDBY_SUBDOMAIN_LABEL` (default `standby`), `STANDBY_PROBE_LOCAL_PART`
     (default `cmail-standby-probe`), `STANDBY_PROBE_TIMEOUT_MINUTES` (default
     10, 2 to 60).
   - The `[[send_email]] name = "EMAIL"` binding (already in the example).
   - Add `"*/10 * * * *"` to `[triggers] crons`. Without it no daily probe
     runs and the light goes amber, then red.
3. **Email Sending** must already be set up for `MAIL_DOMAIN` (cmail's normal
   outbound mail). The probe is sent from an address on it. Once a sending
   domain is onboarded it can send to any recipient
   ([limits](https://developers.cloudflare.com/email-service/platform/limits/)).
4. **Email Routing on the subdomain.** In the dashboard, Email Service >
   Email Routing > the apex domain > Settings > Subdomains, add
   `standby.<your domain>`. Cloudflare adds the MX and other records on the
   subdomain ([subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/)).
5. **Routing rules on the subdomain.** Catch-all rules are only available on
   the apex domain; a subdomain needs a **literal rule per address**, each
   with the "Send to a Worker" action pointing at the cmail email Worker
   ([routing rules](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)).
   At minimum add `cmail-standby-probe@standby.<your domain>`, then one rule
   per person or shared mailbox that should have a standby address. Email
   Routing allows 200 rules per domain
   ([limits](https://developers.cloudflare.com/email-service/platform/limits/)),
   so a larger organisation can only cover its key addresses this way.
6. **Turn it on** in Admin > Standby test, then press **Run test now**.

To turn it off, use the switch: mail to the standby domain is refused at once
and no more tests run. The routing rules and DNS can stay.

## Failure modes and what to do

| Shown | Likely cause | What to do |
|---|---|---|
| Not configured | A setting is missing or invalid (names listed) | Fix the Worker setting and redeploy the Worker |
| `no_send_binding` | The Worker has no `EMAIL` binding (for example the preview Worker) | Add `[[send_email]] name = "EMAIL"` |
| `send_rejected` `E_SENDER_NOT_VERIFIED` / `E_SENDER_DOMAIN_NOT_AVAILABLE` | `MAIL_DOMAIN` is not onboarded to Email Sending | Onboard it, or check the probe local part is on that domain |
| `send_rejected` `E_RATE_LIMIT_EXCEEDED` / `E_DAILY_LIMIT_EXCEEDED` | The account's sending limit was hit | Check outbound volume; the next daily probe retries |
| `send_failed` | A network error or an ambiguous answer from Email Sending | Run test now; if it repeats, check the Cloudflare status page |
| `timeout` | No arrival in time: missing literal routing rule for the probe address, subdomain MX not in place, routing rule pointing at another Worker, the Worker failing on delivery, or a slow delivery | Check the rule and MX in the dashboard, Email Routing activity and the Worker logs; Run test now |
| `late` | Arrived after the timeout | One-off: ignore. Often: raise `STANDBY_PROBE_TIMEOUT_MINUTES` and investigate delays |
| `probe_address_in_use` | Another mailbox already has the probe address | Set `STANDBY_PROBE_LOCAL_PART` to an unused local part |
| `probe_mailbox_disabled` | A manager disabled the probe mailbox | Re-enable it in Admin > Mailboxes |
| Amber: filed to Spam | The organisation sender list blocks `MAIL_DOMAIN`, or `SPAM_QUARANTINE_SCORE` caught it | Review the sender rules and threshold |
| Amber: DMARC did not pass | Email Sending DKIM or the domain's DMARC record is wrong | Check the Email Sending DNS records |
| Amber/red: stale | The `*/10` cron is missing or the Worker is failing | Check `[triggers]` and the Worker logs |

Cloudflare's Email Routing summary may show messages a Worker sent with the
`send_email` binding as "dropped" even when they were delivered
([limits](https://developers.cloudflare.com/email-service/platform/limits/)).
Use the Admin page, not that summary, for the probe.

## How to test

Automated (no Cloudflare account needed):

- `apps/email-worker/src/standby/standby.sql.node.test.ts` runs every real
  migration in `node:sqlite` and drives the real `email()` handler: alias
  delivery for personal, pending and shared mailboxes; no catch-all; paused,
  offboarded and disabled refused; exact domain match; switch off; custom
  label; the same spam rules; dedupe across both addresses; the probe pass
  path with round trip and auth; timeout and late; duplicates; the probe
  mailbox refusing non-probes; send refused, failed and unbound; an address
  already in use; a disabled probe mailbox; Run test now limits; switching off
  mid-probe; pruning only probe messages; the private endpoints; and the cron
  doing only one read while off. Email Sending is a mock that records the
  message, and the test delivers that message back as Email Routing would.
- `apps/email-worker/src/standby/status.test.ts`: configuration parsing, the
  address mapping, token parsing and every status-light rule.
- `apps/web/src/lib/server/standby-admin.test.ts`: the Admin switch, Run test
  now through the binding, audit entries and the light from stored results.

By hand, on a test domain first:

1. Complete Setup on a test domain and turn the switch on.
2. Run test now: within a minute the light is green with a round trip.
3. Send from an outside mailbox to `<someone>@standby.<test domain>` (with a
   literal rule for it): the message appears in that person's mailbox, and
   Mail trace shows the standby address.
4. Send to an address on the subdomain with no cmail mailbox (but a rule):
   the sender gets a refusal.
5. Pause that person in Admin > People and send again: refused.
6. Remove the probe address's routing rule and Run test now: red `timeout`
   after the timeout (on the next cron run). Put the rule back.
7. Turn the switch off and send to the standby address: refused.

Not verified yet (needs a real account): that Email Sending delivers to an
Email Routing subdomain in the same account without any loop protection
interfering, that the `X-Cmail-Standby-Probe` header survives the round trip
(the subject fallback covers it if not), and typical round-trip times.
