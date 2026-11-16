# Microsoft 365 welcome emails

**Status:** built, off by default, not yet tested against a real tenant,
real DNS or a real Exchange Online inbox. Tested with every real migration
on `node:sqlite` and a mocked Cloudflare Email Sending binding.

When the [Microsoft 365 sync](m365-sync.md) creates a person in cmail (or
links an existing account that is still pending), cmail can email them once
with plain first sign-in steps. A manager turns it on in **Admin >
Microsoft 365 sync > Welcome emails**. Off, it changes nothing: the cron reads
one settings row and returns, and no mail is sent.

- Code: `packages/shared/src/m365-welcome.ts` (switch, eligibility SQL, the
  email template), `apps/email-worker/src/m365-welcome/welcome.ts` (the
  scheduled sender), `apps/web/src/lib/server/m365-welcome-admin.ts` and
  `apps/web/src/routes/admin/m365-sync/` (Admin).
- Data: migration `0029_m365_welcome_emails.sql` (`m365_welcome_emails`, the
  once-only record; `m365_welcome_state`, the status row). Settings live in
  `org_settings`.
- Tests: `apps/email-worker/src/m365-welcome/welcome.sql.node.test.ts` and
  `apps/web/src/lib/server/m365-welcome-admin.test.ts`.

## Who gets one

A welcome email goes to a person when **all** of these hold, checked when it
is queued and again just before it is sent:

1. the sync linked them (`m365_sync_links`, kind `person`) and they are still
   in scope in Microsoft 365;
2. their cmail account is a standard account, **pending**, has never signed in
   (`last_sign_in` empty) and has no sign-in identity of any kind (Google,
   Microsoft, email code or Access);
3. their address is not a shared mailbox's address;
4. they have no welcome record yet (once only), or a manager pressed Resend;
5. their sync link was created at or after the switch's cut-off (see below),
   unless a manager pressed Send or Resend.

**Shared mailboxes never get one.** The sync creates shared mailboxes as
mailboxes with no account, so they never match rule 1; rule 3 also excludes
an account whose address is a shared mailbox. Managers, paused, offboarded and
out-of-scope people, and accounts the sync did not create, never match.

## Why it needs the Cloudflare Access bridge

A synced account is pending with **no sign-in identity**. cmail's own
"Sign in with Microsoft" button only lets in a person who already has a bound
identity, or who carries a manager invitation link (a single-use token). So
without the bridge, "open cmail and sign in with Microsoft" would fail with
`enrollment_required`.

The [Cloudflare Access bridge](staff-sign-in.md#cloudflare-access-bridge)
signs people in from the Access token (Access signs them in with Entra ID) and,
on a first visit, adopts a pending account that has no sign-in identity by its
verified email. That is exactly a synced account. So with the bridge on, the
email can say "open cmail and sign in with Microsoft" with **no token or magic
link** in it.

Without the bridge, the switch shows "Cannot send: people created by the sync
can only sign in through the Cloudflare Access bridge" and stays off. Use
**Admin > People > Send invitation** for those people instead (it carries a
72-hour single-use link).

## Which address it is sent to

The person's account email, which the sync keeps equal to their Microsoft 365
**primary SMTP address** (`mail`). This is deliberate:

- While Exchange Online is the primary mail service, the domain's MX records
  point at Exchange. Cloudflare Email Sending delivers to the recipient
  domain's MX like any outside sender (Cloudflare's
  [Postmaster reference](https://developers.cloudflare.com/email-service/reference/postmaster/)
  describes delivery to the recipient's MX hosts), so the email lands in the
  person's **Exchange inbox**: the inbox they read today. Their cmail mailbox
  has the same address but receives nothing while Exchange holds the MX.
  That is the right inbox for a standby or mirror deployment: people learn
  about the standby while their normal mail works.
- After a [switch to the standby](standby-switch.md) (MX at Cloudflare Email
  Routing), the same address delivers into cmail itself, which the person can
  only read after signing in. Send welcome emails **before** you need the
  standby.

**Not yet verified live:** that Cloudflare Email Sending does not short-cut
delivery to a domain that is also on Email Routing in the same account, and
that Exchange Online Protection accepts the message into the Inbox. The From
address is on your own domain but the message comes from Cloudflare, so it
must pass DMARC (Cloudflare signs with DKIM for the onboarded sending domain;
Microsoft's
[email authentication overview](https://learn.microsoft.com/en-us/defender-office-365/email-authentication-about)
explains how Exchange Online treats a message from your own domain that fails
it). On the first live run, check one welcome email in Exchange message trace
and in the person's Inbox (not Junk) before sending to everyone.

The From address is the same one manager invitations use: the system email
from Admin > Settings when it is on `MAIL_DOMAIN`, else `noreply@MAIL_DOMAIN`.
It must be on a domain onboarded to Cloudflare Email Sending.

## The switch (Admin > Microsoft 365 sync > Welcome emails)

Managers only. Off by default.

**Cannot send.** The switch is disabled, with the reason, while any of these
is true: migration `0029` is missing; the web app has no outbound provider
(`OUTBOUND_PROVIDER` resolves to none); the email Worker has no `EMAIL` send
binding or cannot be asked ("Cannot send: outbound mail not configured");
the Access bridge is off; `APP_URL`, the organisation name or a valid From
address on `MAIL_DOMAIN` is missing. An unknown answer from the Worker counts
as "cannot send".

**Turning it on shows a warning first**, with the number of people who would
be emailed right now: people the sync created, who have never signed in and
were never sent a welcome email. The manager then picks:

- **Only people created from now on** (default). The cut-off is the moment the
  switch is turned on; people already waiting are not emailed (Admin lists
  them as "Not sent", each with a **Send** button).
- **Also the N people already waiting.** The form carries the N the manager
  was shown; if the number changed meanwhile, nothing is turned on and the
  manager confirms again.

Turning it on is audited (`org.m365_welcome_toggled`) with the choice and N.

**Turning it off** stops all sending and cancels emails not sent yet (their
records are removed, so those people count as waiting again). Sent records
stay. Turning it on again asks the same question with the new count.

**Sync off or dry run.** Nothing is sent while the sync is off. In sync dry
run nothing is queued or sent; each run records how many people would be
emailed and lists up to 200 of them in Admin. A Resend pressed during dry run
waits until dry run is off.

## Exactly once, retries and limits

- **Once only.** `m365_welcome_emails` has one row per account (primary key).
  The Worker claims a row (`queued` to `sending`) with a conditional update
  before sending, so two overlapping runs can never both send it; a lease on
  the status row also keeps runs apart. If a run dies between claiming and
  recording the result, the email may or may not have gone: the next run marks
  it `failed` with `outcome_unknown` and **never sends it again on its own**
  (a manager can Resend). At most once beats a duplicate.
- **Retries.** A failed send is retried after 15, 30, 60 and 120 minutes;
  the 5th failure is final (`failed`). A recipient refusal from Cloudflare
  (`E_RECIPIENT_SUPPRESSED`, `E_RECIPIENT_NOT_ALLOWED`) fails at once. A rate
  limit (`E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`) or a sender
  problem (`E_SENDER_NOT_VERIFIED`, `E_SENDER_DOMAIN_NOT_AVAILABLE`) stops
  the run, keeps the email queued for an hour (six for the daily limit) and
  does not use up an attempt, because it is not the person's fault. Error
  codes are from Cloudflare's
  [Email Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).
- **Bounded.** At most 20 sends per cron run (every 15 minutes) and
  `M365_WELCOME_MAX_PER_HOUR` (default 50, 1 to 500) per rolling hour; up to
  200 people are queued per run.
- **Audited.** Every attempt writes one audit row: `m365_welcome.sent`,
  `m365_welcome.send_failed` (will retry), `m365_welcome.failed` (final) or
  `m365_welcome.skipped` (no longer eligible), with the account id as target
  and no subject, body or address. Manager actions: `org.m365_welcome_toggled`,
  `org.m365_welcome_note`, `m365_welcome.resend_requested`. Worker logs carry
  counts and codes only.

**Admin shows** counts (Sent, Waiting to send, Failed, Skipped, Not sent),
the last run's result and problem, the dry-run list, a preview of the email,
and up to 200 people with status, attempts, last attempt and error. **Resend**
(or **Send** for someone never queued) is offered for people who are still
eligible and not already waiting; it re-queues that one person, audited.

## The email

Plain and short, HTML and text parts, `lang="en"`, an ordered list for the
steps, link colours that meet WCAG AA contrast (the brand colour is used for
text only when it reaches 4.5:1 on white, otherwise a standard blue; it is
always used for the top border). **No images** (no logo: Gmail and Outlook
strip SVG and data-URI images, and an external image would be a tracking
request), no tracking pixel, no external resources, no token: the only links
are `APP_URL` and the contact's `mailto:`. Every value is HTML-escaped and
header values are kept on one line.

Template text, with passkey sign-in on and no standby sentence (the example
values are placeholders):

> **From:** Example Org Mail &lt;noreply@example.com&gt;
> **Subject:** Your Example Org mail account is ready

```text
Example Org

Hello Alex,

You now have a mail account at Example Org in cmail.

To sign in for the first time:

1. Open https://mail.example.com
2. Choose Sign in with Microsoft and use your work account (alex@example.com).
3. If you are asked to accept the IT policy, read it and accept it.
4. Add a passkey: in the left menu choose Settings > Passkeys, then Add passkey. Do this soon after you sign in. A passkey lets you sign in with your fingerprint, face or PIN if Microsoft sign-in is ever unavailable.

Questions? Contact desk@example.com.

Example Org will never ask for your password by email.

--
Sent by Example Org with cmail.
```

- **Step 4** appears only while [passkey sign-in](passkeys.md) is switched on
  (checked at send time). "Soon after you sign in" matters: adding a passkey
  needs a session opened in the last 15 minutes.
- **Hello Alex** uses the first word of the display name; with no name it is
  just "Hello,".
- **Questions?** uses the support email from Admin > Settings, and is left out
  when there is none.
- **Standby sentence** (optional, off by default): set it in Admin, for
  example "This is our standby mailbox. Keep using Outlook as usual; you only
  need it if Microsoft 365 email is down." It is added after "You now have a
  mail account…". Plain text, one paragraph, up to 300 characters; empty
  leaves it out.

### How to customise

| What | Where |
|---|---|
| Organisation name, From address and name, contact | Admin > Settings (org name, system email, system From name, support email), or `ORG_NAME`, `SYSTEM_EMAIL`, `SYSTEM_FROM_NAME`, `SUPPORT_EMAIL` |
| Link | `APP_URL` |
| Product name in the text and footer | Admin > Settings app name, or `APP_NAME` |
| Colour | `BRAND_PRIMARY_COLOR` |
| Standby sentence | Admin > Microsoft 365 sync > Welcome emails |
| Wording | `renderWelcomeEmail` in `packages/shared/src/m365-welcome.ts`, in your own fork or deployment branch (keep the tests in `welcome.sql.node.test.ts` passing: no images, no external links, passkey step only when on) |

The web app owns the organisation details, `APP_URL` and the Access bridge
settings, so it saves a snapshot of them (`m365_welcome_profile` in
`org_settings`) for the Worker every time a manager opens **Admin >
Microsoft 365 sync** and when the switch is turned on. After changing them in
Admin > Settings or redeploying with new values, open that page once; the
preview there shows exactly what will be sent.

## Configuration

Email Worker (`apps/email-worker/wrangler.toml`, `[vars]`):

| Setting | Default | Notes |
|---|---|---|
| `M365_WELCOME_MAX_PER_HOUR` | `50` | Sends per rolling hour, 1 to 500 |
| `EMAIL` (`[[send_email]]` binding) | — | Required. The same binding the web app's outbound mail uses through `EMAIL_SERVICE` |
| `MAIL_DOMAIN` | — | Required. The From address must be on it or a subdomain |

Web app: `APP_URL`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (the bridge),
`OUTBOUND_PROVIDER`, the organisation settings above, and the
`EMAIL_SERVICE` binding (Admin asks the Worker over it whether it can send).

No new cron: it runs on the sync's `*/15 * * * *` schedule.

## Runbook

1. Apply migration `0029` (`pnpm db:migrate`; owner's yes for a live
   database). Deploy the email Worker, then the web app.
2. Make sure the Access bridge, the sync and Cloudflare Email Sending for the
   From domain all work. Send yourself a normal test message first.
3. Open Admin > Microsoft 365 sync. Read the preview; set the standby sentence
   if you want one.
4. With the sync in **dry run**, turn welcome emails on ("only people created
   from now on"). The next run lists who would be emailed.
5. Before the first live send, pick one test account in Microsoft 365, let the
   sync create it (dry run off), and check the email in Exchange message trace
   and in that Inbox.
6. Then, if you want, use **Send** on the people already waiting, a few at a
   time, or turn the switch off and on again with "also the N already
   waiting".

**Failed rows.** `E_RECIPIENT_SUPPRESSED`: the address bounced before; check
it, unblock it in Cloudflare, then Resend. `outcome_unknown`: check Exchange
message trace before pressing Resend. Last result "stopped by Cloudflare Email
Sending" with `E_SENDER_*`: the From domain is not (or no longer) onboarded
to Email Sending.

## Limits

- English text only.
- No logo (see above).
- One email per person; no reminders.
- The Access bridge adopts the account by the email in the Access token. If a
  tenant's sign-in name (UPN) differs from people's primary SMTP address,
  check which one Access passes before turning this on; the email names the
  primary address as "your work account".
- The Worker renders from the last saved snapshot of the organisation details
  (see "How to customise").
- Built and tested with mocks only; the delivery path into Exchange Online is
  not yet proven on a real tenant.
