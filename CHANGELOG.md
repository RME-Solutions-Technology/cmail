# Changelog

Notable changes to cmail are recorded here. The project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and intends to use
[Semantic Versioning](https://semver.org/) after the first stable release.

## [Unreleased]

### Added
- Shared mailbox access from Exchange Online (optional, off by default, own Admin switch, dry run first). Once a day (`M365_PERMS_INTERVAL_HOURS`, 6 to 24) and on **Sync access now**, the email Worker's `*/15` cron starts a Cloudflare Container (Durable Object `M365PermsCollector`, `durable_object` scheduling policy, public beta; needs Workers Paid) that runs a read-only PowerShell collector (`apps/email-worker/container/m365-perms/collect.ps1`: Ubuntu 24.04, PowerShell 7.6.10, ExchangeOnlineManagement 3.11.1, pinned): app-only certificate sign-in (`M365_EXO_APP_ID`, `M365_EXO_ORGANIZATION`, secrets `M365_EXO_CERT_PFX_B64` and `M365_EXO_CERT_PASSWORD`, a separate Entra app with `Exchange.ManageAsApp` and a custom read-only Exchange role group), then `Get-EXOMailbox`, `Get-EXOMailboxPermission`, `Get-EXORecipientPermission` and `Get-EXORecipient` only, through an allow-list that refuses any other command. Large tenants are read in batches of up to 10 minutes, one per cron run, and a pass is applied once, only after its last batch (at most 24 batches; at most 4 scheduled passes a day). Trustees are resolved only through documented lookups (Sid filter on Get-User/Get-Group, then the GUID; or the returned identity), exactly one match. Its JSON snapshot (keyed by Entra object id, versioned contract, strict validation: exact keys, tenant and organisation match, 8 MiB cap, 36-hour age limit) is mapped through the Microsoft 365 sync's links: Full Access + Send As becomes cmail Full, Full Access alone Read (or Full with `M365_PERMS_FULLACCESS_IMPLIES_SEND`), Send As alone nothing; group grants are expanded with Graph `transitiveMembers`. The sync only changes assignments it made itself (new ledger table with an exact `assigned_at` marker; triggers hand a row to the manager as soon as anyone else edits or removes it, and a manager's removal is not undone while Exchange still grants it), never a manager's, never a personal mailbox; a mailbox with any Deny entry is left as it is. Removals need a mailbox the snapshot fully read; a failed, timed-out, partial, empty or invalid collection changes nothing, backs off and alerts in Admin after 3 failures in a row; a removal brake holds removals and downgrades above `M365_PERMS_MAX_REMOVE_PERCENT` (default 20) of sync-made grants for approval (an empty tenant answer is never approvable). Every change is audited. Admin > Shared mailbox access shows the switch, dry run, last run, counts, held removals and failures. Needs migration `0028` (four tables, two triggers, additive). Container size standard-1; estimated cost at a daily cadence about USD 0.01 a month beyond Workers Paid in the worst case. Built and tested with mocked cmdlets, a fake container and a fake Graph; not yet tested against a real tenant or a deployed container. Setup, exact Exchange RBAC PowerShell, failure modes and rollback: docs/m365-mailbox-permissions.md.
- Microsoft 365 sync: shared mailbox detection (optional, off by default). With `M365_DETECT_SHARED_MAILBOXES = "true"` the email Worker reads Exchange Online's mailbox type (`GET /users/{id}/mailboxSettings/userPurpose`, 20 per JSON `$batch`, application permission `MailboxSettings.Read` with admin consent) for every object whose primary address is on `MAIL_DOMAIN`, disabled and unlicensed ones included. `shared` becomes a cmail shared mailbox on the same path as `M365_SHARED_GROUP_ID` (created or linked, nobody assigned, address changes followed, never disabled or deleted; both options work together); `room` and `equipment` are never people; `user`, `linked`, `others` and "no Exchange Online mailbox" (404) keep the licensed-person rule unchanged. The type is cached per object id (new table `m365_sync_mailbox_purpose`, migration `0026`, additive): read once, again at each daily full reconciliation, never on every delta round. Switching detection on (or on again) clears the cache and forces a full reconciliation. In a delta round a 404 is not stored and a new unlinked object is not created on it (it may still be provisioning). A failed or denied lookup changes nothing for that object; it is asked again when Graph next returns it (a delta round if it changed, else the daily reconciliation), and after 3 failed reconciliations in a row for a linked object Admin alerts and an audit row (`m365_sync.type_unreadable`) is written. Throttling honours `Retry-After` and keeps the answers already read; the Graph budget is checked before every `$batch`. The scope group, when set, also limits detected shared mailboxes. Dry run reports what would be created. Admin > Microsoft 365 sync shows whether detection is on and counts Shared found, Shared created and Type unknown. Built and tested against a fake Graph; not yet run against a real tenant. docs/m365-sync.md#shared-mailboxes.

### Fixed
- Microsoft 365 sync and standby copy-back: the Graph client called the global `fetch` as a method of itself, which Cloudflare Workers rejects ("Illegal invocation"), so every live run failed as `network`. It is now always called unbound; network errors also log the underlying error name (never its message). docs/m365-sync.md.
- Standby copy-back: a create is never retried in place after a 503/504 (Exchange may already have stored it), so the next attempt's marker lookup prevents a duplicate; Sent copies keep Bcc; the draft canary fails closed when Exchange's answer does not say `isDraft: false`; a copy of a self-addressed message in the user's own Sent Items or Drafts no longer makes the Inbox copy look already delivered; the job lease is cleared only by its owner. No schema change. docs/copy-back.md.

### Changed
- License: from this change on, cMail is licensed under the Apache License 2.0 (was MIT). The new license keeps the permissive terms and requires anyone who redistributes cMail or a derived work to keep the LICENSE and the NOTICE file (credit to RME Solutions Technology), keep copyright and attribution notices in source files, and state significant changes. It also gives an explicit patent grant. Copies you already received under the MIT License stay under MIT. The new `NOTICE` file is part of the license terms for new versions.

### Added
- Passkey break-glass sign-in (optional, off by default). A manager switch in Admin > Passkey sign-in. While signed in the normal way (in a session opened in the last 15 minutes, never a passkey session), people add up to 10 WebAuthn passkeys under Mail > Settings > Passkeys (name, date added, last used; remove any time) and they and every manager are emailed for each one added or removed (missed notices are audited and Admin warns when mail is not set up; Admin also lists the newest passkeys). At `/auth/passkey` they sign in with a passkey alone, with no dependency on Microsoft or Cloudflare Access: discoverable credentials, user verification required, attestation `none`, Ed25519/ES256/RS256 only, verified with `@simplewebauthn/server` 14.0.3 (pinned). Challenges are stored in D1, single use and expire after 5 minutes; origin and RP ID must match `APP_URL` exactly; the user handle must match; the signature is verified before the counter is compared, the counter must go up (a rollback on a valid signature is refused, audited and emailed to managers) and moves with a compare-and-set. Every refusal returns the same message (no user enumeration); unknown passkey ids are audited as an hourly count. Rate limits: challenges per address, failed sign-ins per address (successes never count), valid sign-ins per passkey; IPv6 is keyed per /64 and there is no global cap. Paused and offboarded accounts cannot sign in; managers can (break-glass), audited separately and emailed to all managers. Passkey sessions follow the normal cap and policy rules but last a fixed `PASSKEY_SESSION_TTL_HOURS` (default 8, never renewed), work only on `APP_URL`'s origin and for active accounts, cannot approve AI app (MCP) connections, and carry a marker (`sessions.passkey_credential_id`): with the Access bridge on they are the one kind of session used without an Access token, a passkey session for someone other than the Access token's person is set aside rather than revoked (and revoked once Access replaces its cookie), and every other session stays fail-closed as before. Removing a passkey, pausing the account or turning the feature off ends its sessions. When off, the passkey routes answer 404 and the settings page and sign-in link are hidden. The sign-in page loads nothing outside `/auth/passkey`, so only that path needs a Cloudflare Access Bypass. Also: a sign-in route's fresh session cookie is no longer followed by a clearing cookie from a stale one. Needs migration `0025` (two new tables and one nullable column, additive). Setup, the Access Bypass steps, the outage step and recovery: docs/passkeys.md.
- Standby switch and switch-back scripts (`scripts/standby/`, run by a person after the owner's yes; no migration, no app change). `switch.mjs` reads a domain's mail records through the Cloudflare API and points the apex MX at Cloudflare Email Routing in one DNS batch (one transaction, all or nothing); `switch-back.mjs` restores each original MX record's host, priority, TTL and comment from the timestamped, checksummed snapshot the switch saved, unlocking Email Routing's records first only when its status says they are locked. Both are dry runs that print the change set and the reverse change set unless `--apply` is given and the domain is typed at an interactive terminal; `--apply` is refused under CI. The apply snapshot is written only after the confirmation and is read back and checked against switch-back before anything changes; switch-back refuses a dry-run snapshot unless `--allow-dry-run-snapshot`. The switch refuses a zone not on Cloudflare DNS or not the apex, Email Routing not enabled (Cloudflare error 2008: first-time onboarding is a documented manual drill that ends with a full scripted switch and switch-back), locked records, a catch-all that does not send to the cmail Worker, MX TTLs above `--max-ttl` (default 300 s, with steps to lower them), and a standby probe that is not green when it can read it (`--probe-d1`). SPF, DKIM and DMARC are left untouched by default, so Exchange outbound is unaffected; `--spf-include` opts in to adding `include:_spf.mx.cloudflare.net`. Exit codes: 0 done, 1 nothing changed, 2 applied but not as planned, 3 outcome unknown (re-reads and prints the undo command), 4 unlocked only. The token comes from `CLOUDFLARE_API_TOKEN`, is never printed, and is only sent to `api.cloudflare.com`. Tested only against a mocked Cloudflare API; the prepared state and the scripted apply path are proven only by the first-time drill. Runbook: docs/standby-switch.md.
- Standby test address and daily probe (optional, off by default). With a manager switch in Admin > Standby test, `name@standby.<MAIL_DOMAIN>` (label set by `STANDBY_SUBDOMAIN_LABEL`) delivers into the same mailbox as `name@<MAIL_DOMAIN>` under exactly the primary address's rule (an active mailbox), with no catch-all, no forwarding and the same inbound limits, sender rules, spam quarantine and inbox rules as the primary address. A new `*/10 * * * *` email Worker cron sends one message a day through Cloudflare Email Sending to a dedicated system mailbox's standby address (created on first use, nobody assigned, it accepts only live probes) and records time, round trip, folder, SPF/DKIM/DMARC and pass or fail with the exact reason (`timeout`, `late`, `send_rejected` with the error code, `no_send_binding` and others). Admin shows a green, amber or red light, the last result, the last 7 days and **Run test now** (one at a time, once a minute). Probe messages are pruned after 7 days and results after 30. The subdomain needs Email Routing with one literal rule per address (Cloudflare has no catch-all on subdomains). Unproven for the main use case: Cloudflare Email Routing needs exclusive control of the root domain MX (error 2008), so subdomain-only routing beside an Exchange apex MX must be tried on a real account first. Needs migration `0023` (two new tables, additive). Not yet tested against real DNS. Setup and what a green does and does not mean: docs/standby-probe.md.
- Copy standby mail back into Exchange Online (optional, off by default). After an outage, a manager-only page, Admin > Copy back to Exchange, copies mail that arrived in cmail during a chosen UTC window into each linked person's (or one person's) Exchange mailbox through Microsoft Graph v1.0: received Inbox mail by default, Archive and Sent only when ticked, never Drafts, Spam or Trash. A dry run (counts only, from D1) must match the exact window, scope and folders, and Start refuses if the selection itself changed since (per-mailbox counts), then freezes it. Copies are created with the JSON message resource and extended properties (non-draft flags, original delivery time, a cmail marker property and the category "cmail standby copy"), keep sender, recipients, attachments, inline images and threading ids, and are set unread afterwards when they were unread in cmail. Each (message, Entra object id) pair is copied at most once: per-item state (pending, copied, failed, skipped) in migration `0024`, database triggers that keep a copied item final, and a marker lookup before every create so a cut-off attempt is found, not repeated; messages Exchange already holds (same Message-ID, ignoring our own copies) are skipped, and messages over 3 MB are skipped and listed. A draft canary halts the job if Exchange ever stores a copy as a draft. Work per cron run is bounded and resumable, Cancel and switch-off apply between items, throttling defers only the affected mailbox, and a failing item (5xx, network, storage) counts an attempt, backs off and gives up after 6 attempts until a manager presses Retry failed, without holding up the rest. Nothing is deleted in cmail or Exchange; status, logs and audit carry counts and reason codes only. Uses a separate Entra app (`M365_COPYBACK_CLIENT_ID`, secret `M365_COPYBACK_CLIENT_SECRET`) whose `Mail.ReadWrite` comes only from Exchange RBAC for Applications scoped to a mail-enabled security group. Built and tested with a mocked Graph; not yet tested against a real tenant. Setup and runbook: docs/copy-back.md.
- Microsoft 365 mailbox sync (optional, off by default). A manager-only switch in Admin > Microsoft 365 sync, with Dry run (on by default) and Sync now, lets the email Worker read the tenant's users through Microsoft Graph (read-only: `User.Read.All`, plus `GroupMember.Read.All` only when a group is used) and keep cmail in step. Users are keyed on the immutable Entra object id, never the UPN or address. A stored `users/delta` link catches changes every hour (`M365_SYNC_INTERVAL_MINUTES`), and a daily full reconciliation (also on Sync now, after `410 Gone`/`syncStateNotFound`, and before the 7-day token limit) is the safety net. Enabled members with an Exchange Online mailbox plan (matched by service plan id, so Exchange Foundation alone does not count) and a primary address on `MAIL_DOMAIN` (optionally only members of `M365_SCOPE_GROUP_ID`) get a pending standard account and personal mailbox, or an existing standard account with that address is adopted. Address and name changes update the account and mailbox instead of recreating them. Disabled, unlicensed, deleted or out-of-scope people are paused once (sessions and AI app grants revoked, with the same function Admin > People uses), conditionally on the status the sync read so a concurrent manager action wins; any status change clears the sync's mark (trigger in `0022`), so the sync resumes only accounts it paused and nobody touched since. A mass-pause brake holds a round that would pause at least 5 people and more than `M365_SYNC_MAX_PAUSE_PERCENT` (default 20) percent of linked people, or a reconciliation that returns nothing, until a manager presses Approve large change or Discard and sync again. Nothing is ever deleted, managers are never created or touched, and shared mailboxes come only from an explicit `M365_SHARED_GROUP_ID` group (created or linked, no one assigned, never disabled), because Graph cannot reliably tell a shared mailbox from a leaver. Every change is audited; Admin shows last run, result, error code, delta link age and the last round's counts and changes. Work per cron run is bounded and resumable, `Retry-After` is honoured on 429/503/504, and page links are only followed on `graph.microsoft.com/v1.0`. The client secret is a Worker secret (`M365_CLIENT_SECRET`); Admin shows "not configured" with the missing setting names instead of failing. Needs migration `0022` (two new tables, additive) and the new `*/15 * * * *` email Worker cron. Setup, Entra app steps and runbook: docs/m365-sync.md.
- Cloudflare Access bridge sign-in (optional, off by default). With `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` set, cmail verifies the `Cf-Access-Jwt-Assertion` token on every request (RS256 only, keys from the team certs endpoint with caching, exact issuer and audience, expiry and not-before with 60 seconds of skew) and signs the person in with no second sign-in screen. Accounts are bound by the Access `sub` as a new `access` identity, never by email alone on return visits; a first visit adopts an existing standard account by verified email only if it has no sign-in identity yet, while managers and people who already sign in with Google, Microsoft or an email code link by signing in once the normal way behind Access, and `ACCESS_AUTO_PROVISION=true` creates a standard account and personal mailbox only for emails on `MAIL_DOMAIN`. Paused, offboarded and already-bound accounts are refused, the country gate runs before any binding, and nothing happens before the first manager exists. Managers can clear an account's Access link in Admin > Users (audited) when someone is re-added with a new Access `sub`. Repeated denials are audited once per 10 minutes, and a session is minted only for a browser with no valid cmail cookie. AI app (MCP) bearer paths are unchanged and need their own Access policy or to stay off. Once configured it fails closed: a request without a valid token gets no session, even with a cmail cookie. Sign-out also ends the Access session. Migration `0021` allows `access` in `user_identities` and lets an account hold one Access identity beside its existing sign-in identity: run `pnpm db:migrate` before setting the variables. Setup: docs/staff-sign-in.md, "Cloudflare Access bridge".
- Docs: a "How cmail works" section for developers and operators: how cmail runs on Cloudflare (deployables, bindings, crons, migrations, `config:check`), how sending works, delivery status and bounces, how receiving works, reading mail safely (HTML cleaning, image blocking, link checks), and how inbox rules run. A new upgrade guide explains where each setting lives and how to check for new settings after pulling. The docs can also be read and searched at cmail.incitat.io/docs/.
- Sent list delivery tags: each row in Sent shows Delivered, Delayed, Bounced or Spam report before the subject, from the same Email Sending events as the open message (hover or screen readers get the full status, such as "Delivered to 1 of 2"). One lookup per page; no migration.
- Blocked recipients: when Cloudflare refuses a send because a recipient is on its suppression list (after an earlier hard bounce or a spam complaint), the compose page now says which address is blocked and why, with a **Send again** button, in place of a generic 502 error page. With `CLOUDFLARE_ACCOUNT_ID` and a separate `CLOUDFLARE_SUPPRESSIONS_API_TOKEN` secret (Email Sending: Edit; it doesn't change how mail is sent), an **Unblock and send again** button lifts a bounce block for an address this mailbox was refused for in the last day; complaint and read-only blocks are never lifted. Deploy the email worker with the web app: the worker now returns Cloudflare's error code.
- Undeliverable notices: a bounced, failed or rejected recipient now also puts an "Undeliverable: <subject>" notice from Mail Delivery System in the sender's Inbox, laid out like a standard non-delivery report (cause, who has to act, how to fix it, then the status code, remote server reply, original message details and message hops for email admins). Needs the Email Sending events subscription; no migration.
- Delivery status from Email Sending events: a status line on the sender's Sent copy (Delivered, Delayed and retrying, Not delivered, marked as spam) with each recipient's state under Details, and a Delivery timeline in Admin > Mail trace with times, the remote server's reply, delivery time and the bounce, failure or rejection reason. Migration `0020` adds these event fields: run `pnpm db:migrate` before deploying the email worker, or its event writes fail and are retried, then dead-lettered. Instances without the events subscription see no change.
- Bounce and complaint feedback from Cloudflare Email Service (optional). The email Worker reads Email Sending events from a Queues event subscription: a bounced, failed or rejected recipient is added to Failed recipients on the sender's Sent copy and on the mail trace, and every event is listed under Delivery events in Admin > Mail trace. Events for mail cmail did not send are dropped. New `delivery_events` table (migration `0019`): run `pnpm db:migrate` before deploying the email worker and web app. Setup: docs/deployment.md, "Bounce and complaint feedback".

### Changed
- The repository moved to `RME-Solutions-Technology/cmail`. GitHub redirects the old address. Update your `origin` remote, and set `REPO_URL` to the new address so the manager update notice keeps working without a redirect.
- Docs: `INBOUND_AUTHSERV_ID` for Cloudflare Email Routing is `mx.cloudflare.net` (Cloudflare documents it). With it set, inbound SPF, DKIM and DMARC results are recorded in mail trace and trusted calendar updates turn on. Tests cover a Cloudflare-stamped record and a spoofed one below it.
- Email worker: recorded SPF, DKIM and DMARC verdicts (and the calendar DMARC gate) now come from the first `Authentication-Results` header in the parsed message, not the comma-joined `message.headers` value, so sender-controlled text in the boundary's own record cannot pull a forged record into it. The recorded source IP comes from the same header; the pre-parse rate-limit signal now always keys on the envelope sender.
- Tests: mail reliability coverage for outbound sending. Provider failure mapping (Postmark and the Cloudflare binding: definite 4xx versus ambiguous 5xx, network and malformed responses; Cloudflare REST: authentication failure and malformed responses) and the outbound journal on the real schema (accepted, ambiguous, retryable and permanent outcomes, stale-token and replay safety, quota release, idempotency-key reuse) and that every mail-trace status is stored.
- Accessibility: links on the privacy and terms pages, and links in running text in Help, are now underlined so they don't rely on colour alone (WCAG 1.4.1).
- CI: the E2E workflow now checks performance budgets for sign-in, inbox, a message and compose on a phone with the CPU slowed 4x (JavaScript and CSS size, Largest Contentful Paint, Cumulative Layout Shift).

## [0.2.0] - 2026-10-31

### Added
- Click-time link checks: message links go through `/link`, which checks the site against a local copy of the CERT Polska Warning List (refreshed hourly by the email Worker; needs Workers Paid) and shows a warning for listed sites. A backstop only: coverage is mostly Polish threats, and unlisted links are never called safe. Signed links prevent `/link` being used as an open redirect.
- Optional backup Worker (`apps/backup-worker`): hourly incremental copy of mail bodies and attachments to a separate private R2 bucket, a daily manifest of every object, a daily NDJSON dump of every D1 table plus the schema, and deletion-honouring retention (deleted mail is dropped from the backup after `BACKUP_RETENTION_DAYS`, default 30). Scheduled only, no HTTP surface. See docs/deployment.md, "Automated backups".
- Inbox rules, like Outlook's (Mail > Settings > Rules): per-mailbox rules for anyone with full access, with conditions (From, Sent to, subject/body/header/address text, where my address appears, attachment, importance, size, or all messages), exceptions, and actions (move to Archive, Junk or Deleted, mark read, star, set importance). Rules run in order with "stop processing more rules", on external mail in the email worker and on mail between cmail mailboxes, after organisation junk filtering, and never on quarantined mail. Includes Create rule from a message, Run now on the newest 1,000 Inbox messages, mail-trace notes, and audit records. Rules never forward or redirect mail. New `inbox_rules` table (migration `0018`): run `pnpm db:migrate` before deploying the email worker and web app.
- Outlook-style formatting bar in compose: font and size, bold, italic, underline, strikethrough, font and highlight colour, lists, indent, alignment, link (Ctrl+K, http(s) and mailto only), quote, clear formatting, undo and redo, with Outlook's shortcuts, pressed states, tooltips and arrow-key navigation. Built on TipTap's text-style and text-align extensions (3.31.4), plus a small indent extension. On phones it is one swipeable row with the most-used controls, a More sheet and 44px targets, stuck above the keyboard.
- Default font: new messages, replies and forwards start in Aptos 12 pt (falling back to Calibri, Arial, sans-serif), in black, like Exchange/Outlook. Each person can pick another font and size under Mail > Settings > Font and signature (new `compose_preferences` table, migration `0017`; existing deployments run `pnpm db:migrate` before `deploy:web`, and until then compose falls back to Aptos 12 pt). Sent HTML is wrapped in a container with that font and size so Outlook, Gmail and Apple Mail start from the same font.
- Paste from Word and Outlook keeps bold, italic, underline, lists (Word's paragraph lists become real lists), links, colours and sizes, and strips `mso-` styles, classes and conditional comments.

### Changed
- Docs: deployment guide adds "Rotate credentials" (what changes for each secret when it is rotated).
- Docs: deployment guide adds point-in-time recovery with D1 Time Travel (bookmark before migrations, approved in-place restore, rehearsal on a preview database) and notes that it does not cover R2.
- CI: a new `E2E accessibility` workflow runs the axe and smoke specs of the mobile suite (Pixel 7 and desktop Chrome) on every pull request and push to main, against a local build with invented fixtures.
- Patch updates (late October 2026): TipTap 3.32.1, Svelte 5.57.3, typescript-eslint 8.72.1, Wrangler 4.155.0 and workers-types 5.20261029.1. No behaviour change intended.
- MCP 2026-07-28 recommendations: every modern result carries `serverInfo` in `_meta`; a modern `ping` gets HTTP 404 and `-32601` (ping was removed in that revision; legacy clients keep it); `move_message` is marked destructive so hosts can ask before moving mail to Trash or Spam; Client ID Metadata Documents are cached for their `Cache-Control` max-age (5 minutes to 24 hours, 24 hours when none is given) instead of always a day; and the consent screen warns when an app asks to return to a program on this computer (a loopback address).
- MCP 2026-07-28 conformance: modern `server/discover` and `tools/list` results now carry the required caching hints (`ttlMs` and `cacheScope`: `public` for discover, `private` for the scope-dependent tool list), and a modern request whose `_meta` lacks `io.modelcontextprotocol/clientCapabilities` (or, with a modern `MCP-Protocol-Version` header, lacks `io.modelcontextprotocol/protocolVersion`) is rejected with HTTP 400 and `-32602`, as the revision requires. Legacy (initialize-based) clients are unaffected.
- Compose polish: the message body has comfortable inner padding (20px on desktop, 16px on phones) so text and the caret no longer sit on the edge; the compose column fills the pane up to 1120px instead of 820px; and in dark mode the body sits on the surface tone (display-only colour inversion, so default and pasted black text read light) instead of a bright white sheet, with a primary underline as the focus cue. Styling only.
- No-borders pass on the mail surfaces: compose drops its framing card (header lines keep one faint hairline, the formatting bar loses its grey band and button boxes, Rich text / Plain text are quiet tabs, Save draft and Add files are text buttons), the inbox list and reading pane lose their outer frames, attachment chips and labels are tone-only, and in the mail sidebar the mailbox picker is a quiet select, the pane and footer dividers become a tone step, section labels drop their caps and New-mail alerts' Turn off is a text button. Styling only.
- No-borders pass for settings, management, calendar, sign-in and help: card frames, boxed sub-panels and outlined secondary buttons are gone; sections are separated by headings and space, secondary actions are quiet text buttons (one filled primary per view), lists keep only quiet row separators, and fields are single typed-on lines. Focus rings, checkbox and toggle outlines, popover and side-panel edges, and the Google and Microsoft sign-in buttons keep their borders. Restyle only.
- Sleek uplift: sign-in, email-code sign-in and the help centre are lighter: hairline cards, typed-on-line code fields, one title size and plain section labels. Styling only.
- Calendar looks lighter: the agenda is one hairline-edged surface with quiet day headings and thin row separators instead of a shadowed card with grey day bars, and the new-meeting form uses single typed-on lines with a hairline rule instead of boxed fields.
- The Management centre looks lighter, like Outlook on the web: pages sit on a white canvas, form fields are typed-on lines with a small label instead of boxes, settings are grouped by headings instead of bordered cards, tables and lists drop their outer boxes for quiet row separators with muted secondary text, row buttons on People are quiet and show on hover with a mouse, status labels lose their caps and borders, page titles share one size, and the public organisation directory follows suit.
- Reading a message looks lighter, like Outlook on the web: the toolbar is a quiet command bar (Reply is the one filled button), the message sits on one surface with a hairline edge instead of a shadowed card, attachments are plain file chips without a grey panel, the message body no longer has a second box around it (dark mode keeps a hairline edge on the white sheet), and the Details list and safety notices drop their heavy borders.
- Sleek uplift for settings: Font and signature, Rules (list and editor) and Connected AI apps use typed-on-line fields, hairline rules and a quiet list instead of boxed cards and fields. Restyle only.
- The inbox list is quieter, like Outlook on the web: no shadowed card, hairline row separators, plain muted mailbox labels instead of grey chips, and a bulk-action bar of quiet text buttons that fade (rather than grey out) when nothing is selected. Same actions, same behaviour.
- Compose, reply and forward look like Outlook: From, To, Cc, Bcc and Subject are single typed-on lines with a hairline rule instead of boxed fields, importance sits at the end of the subject line, and the message body fills the rest of the page without a heavy border.
- Dependency upgrade (October 2026): SvelteKit 3 with adapter-cloudflare 8 (settings now live in the `sveltekit()` options in `apps/web/vite.config.ts`; `svelte.config.js` is gone; `$lib` imports became `#lib`; `handle` rebuilds `event.platform` from `cloudflare:workers` because the adapter no longer provides it; MCP authorisation errors redirect with `external: true`), postal-mime 4 (fixture suite in `apps/email-worker/src/postal-mime-fixtures.ts`), TipTap 3.32, Vite 8.3.5, Vitest 5.0.5, Wrangler 4.151.3, ESLint 10.13, pnpm 12.15.0 and newer GitHub Actions. The web app stays on TypeScript 6.0.x because SvelteKit 3 and svelte-check require it; `svelte-check --tsgo` still checks with TypeScript 7.0.2. Node 22.17 is now the minimum (SvelteKit 3).
- The compose sanitizer now keeps a minimal `style` allowlist on span, p, li, blockquote and div (font family from the fixed list, bounded font size, hex/rgb colour and highlight, text-align, underline/line-through, weight, italic, bounded margin-left). Every other property, and any style with url(), expression(), escapes, comments or behaviour, is removed. The reading sanitizer and CSP are unchanged. Plain-text mode and the generated text/plain part are unchanged.
- Mail > Settings > Email signature is now **Font and signature**.

### Fixed
- Links in a message now open in a normal tab. They opened in a tab that inherited the message frame's sandbox, which sites with strict headers (Instagram, Facebook) refuse with `ERR_BLOCKED_BY_RESPONSE`. The frame adds `allow-popups-to-escape-sandbox`; it still never runs script.
- Pages no longer break on a hard refresh behind a Cloudflare zone with Email Address Obfuscation on (the default for new zones). Cloudflare rewrote addresses in the served HTML, so the inbox failed to hydrate (`hydration_mismatch`). The app shell now wraps the page body in `<!--email_off-->` comments, which Cloudflare honours, so pages are left alone while still being compressed at the edge. The retired `interest-cohort` feature is dropped from `Permissions-Policy`, which browsers reported as unrecognised.
- On phones, the bottom bar in new message, reply, reply all and forward ran off the right edge once a draft saved: Send and Save draft were pushed off-screen and the page scrolled sideways. Back and Discard draft are now icon buttons on phones (named for screen readers), and the bar wraps rather than overflowing at very large text sizes. The same sideways stretch is fixed on Management > Quarantine (its tables now scroll inside their cards), in the approved sign-in country list, and in the help guides.
- Manager update notices showed "Update status unavailable" on Cloudflare because GitHub's unauthenticated REST limit is shared across Cloudflare egress addresses. The check now reads upstream `main` from Git's ref advertisement, shows "Up to date" or "Update available: <version>", caches at the edge, explains any failure, links the procedure for the configured `REPO_URL`, and can be turned off with `UPDATE_CHECK = "off"`.
- `deploy:landing` now requires `--project-name` and passes it to Wrangler, so a stray `wrangler.toml` in the checkout can't send the product page to another Pages project.

### Added

- Remote MCP (Model Context Protocol) server at `/mcp` so AI assistants
  such as Claude can work with mail, off until a Manager enables it in
  Management > Settings. Streamable HTTP, stateless, dual-era: the 2026-07-28
  revision (per-request metadata, validated mirrored headers,
  `server/discover`) and the initialize-based 2025-11-25, 2025-06-18 and
  2025-03-26 revisions. Thirteen tools for reading, searching, drafting,
  sending, organising and calendar reading, each limited by scope, by the
  mailboxes the person approved, and by their live delegation.
- OAuth 2.1 authorization server for it: RFC 9728 and RFC 8414 discovery,
  Client ID Metadata Documents and RFC 7591 registration, authorization code
  with PKCE (S256 only), exact redirect matching, RFC 8707 audience binding,
  RFC 9207 `iss`, 1-hour access tokens, rotating refresh tokens with reuse
  detection, a 90-day connection limit, and RFC 7009 revocation. Codes,
  tokens and client secrets are stored only as hashes.
- Browser consent screen showing the app (verified host or unverified name),
  return address, scopes (read and draft pre-ticked, send opt-in) and
  personal and shared mailboxes.
- Mail > Settings > Connected AI apps, to review and disconnect apps.
- Per-call audit rows (tool, mailbox, outcome; no content), per-connection
  rate limits, and `MCP_SEND_RATE_PER_HOUR`.
- Migration `0016_mcp_oauth.sql` (additive: new tables only).
- [AI agents and MCP](docs/mcp.md) guide with the threat model and limits.

### Changed

- SvelteKit's built-in CSRF origin check is now enforced by an identical
  check in `hooks.server.ts`, which exempts only the cookie-less
  `/oauth/token` and `/oauth/revoke` endpoints that native OAuth clients
  call without an `Origin` header.
- Pausing or offboarding a person also disconnects their AI apps.
- Message move rules are shared between the message APIs and MCP tools.

### Fixed

- Message bodies shown in a frame (reading view, quoted originals) were not
  resized to their content after a full page load. Svelte's server render
  turned the frame's load handler into an inline `onload` attribute, which
  the app's CSP blocks, so the load event was lost before hydration. The
  listener is now attached in script and a frame that already loaded is
  measured straight away.
- A signature stored only as plain text now also appears in the HTML part of
  outgoing mail (it was previously sent in the text part only).
- In development builds, a full page load of compose (or of mail with a
  pending toast) threw "Cannot call replaceState(...) before router is
  initialized" from `afterNavigate`, which stopped the draft id reaching the
  URL. The URL update now runs right after router start-up.

- Compose opened by a full page load (bookmark, new tab, refresh of
  `/mail/compose`) could not send. The page pinned its recovery id in the URL
  with `replaceState()` from `onMount`, which on hydration runs inside
  SvelteKit's root constructor, before the router has a root. The throw left
  the router without one, so the first autosave failed with "Cannot read
  properties of undefined (reading '$set')", the next save reported "Draft
  changed in another tab", and Send never completed. The URL is now pinned
  from `afterNavigate`, and a URL update can no longer leave a saved draft
  with a stale version.
- `pnpm deploy`, `deploy:web`, and `deploy:email-worker` now call each app's
  `deploy` script with `pnpm --filter … run deploy`. Under pnpm 12 the bare
  `pnpm --filter … deploy` form invokes pnpm's built-in workspace deploy
  command and fails with `ERR_PNPM_INVALID_DEPLOY_TARGET`.

### Security

- Clear all 22 `pnpm audit` findings with in-range overrides: undici ^7.29.1,
  devalue 5.9.4, brace-expansion ^5.0.12, source-map-js ^1.2.2,
  postcss-selector-parser ^7.1.6, and Miniflare's Sharp 0.35.5 (install
  scripts still denied). No majors changed.

### Changed

- Upgrade the build and mail toolchain to pnpm 12.5.1, TypeScript 7.0.2,
  Vitest 5.0.1, postal-mime 3.0.0, Vite 8.3.0, Svelte 5.57.1, and Wrangler
  4.136.1, alongside current compatible direct dependencies and pinned CI
  actions. Node 24 LTS is recommended; Node 22.12 is the minimum.
- Keep TypeScript 6.0.3 solely as the web tooling's required compiler API,
  while validating Svelte with both the existing checker and TypeScript 7's
  native checker. No peer constraints are bypassed. See the
  [dependency upgrade review](docs/dependency-review-2026-09-22.md).

### Added

- Rich-text compose. The message box is now a TipTap (ProseMirror) editor with
  bold, italic, underline, links, bulleted and numbered lists, quote and clear
  formatting, and pasted content is cleaned before it enters the editor. A
  **Plain text** toggle keeps the old textarea, the choice is remembered per
  device, and drafts reopen in the mode they were saved in. The editor is
  loaded on demand by the compose page only. The server never trusts editor
  output: it re-sanitizes the HTML with a narrow compose allowlist (no
  attributes except checked link targets, no styles, scripts or images) using
  the existing rehype-sanitize pipeline, then derives the text/plain part
  from the sanitized tree, so every message goes out as multipart/alternative
  with readable lists, quotes and link addresses. Replies and forwards keep
  the quoted original as HTML, now also quoted with `> ` in the text part.
  Reading and its CSP are unchanged. No migration.

- Remember the provider only after successful returning-account OAuth so a
  later signed-out mailbox visit can start fresh OAuth without guessing an
  identity. The bounded host-only preference is cleared on explicit logout;
  errors retain the normal chooser and enrollment/bootstrap remain explicit.
- Local PNG/AVIF and Miniflare Images checks in the validation gate.
- Pin Vitest and its mocker to 4.1.11 and scope a Sharp 0.35.4 override to
  Miniflare, addressing GHSA-82fw-gwwq-j7x9 and GHSA-rgj7-g3m4-5g8c without
  changing the pnpm or Wrangler toolchain. Sharp install scripts are denied.
- Optional `?sso=1` provider sign-in links that reuse an existing cmail session
  or allow the provider to reuse its browser session without a forced account
  chooser. Invitation and bootstrap account selection remain explicit; the
  existing provider-subject binding and authorization gates are unchanged.
  See the [staff sign-in contract](docs/staff-sign-in.md).
- Provider-aware manager invitations: a Google- or Microsoft-hosted address
  gets a one-button "Activate your mailbox" email straight into that
  provider's sign-in; an address hosted elsewhere gets the same button, but
  it leads to invitation-scoped email one-time-code enrolment instead; and a
  host that can't be verified is refused with a plain error rather than
  silently accepted.
- Email one-time-code sign-in as a third, invitation-scoped identity method
  alongside Google and Microsoft: 8-digit hashed codes with a 5-minute
  expiry and 5 attempts, an identical response regardless of why a request
  or code failed, optional Cloudflare Turnstile on the request form, and a
  session-lifetime cap independent of the configured session TTL. The
  Manager role still always requires a Google or Microsoft identity.
- Manager travel approvals: an organisation can restrict sign-in to approved
  countries across every sign-in method, off by default. A refused sign-in
  creates a pending request, notifies managers by throttled email, and is
  approved for 24 hours, 7 days, or 30 days, denied, or revoked from a
  dedicated panel with a full audit trail. The very first manager's
  bootstrap sign-in is exempt, so a deployment can never lock itself out.
- Real Bcc support end to end: envelope-only delivery so To/Cc recipients
  never see who was blind-copied, deduplication against To and Cc, a
  combined recipient cap, the sender's own sent-copy view of who was
  Bcc'd, and replies that never inherit the original Bcc list.
- Inbound spam scoring and quarantine: the boundary's spam score is recorded
  on every message and in Mail trace, quarantine engages only at an explicit
  operator-set threshold, organisation-wide sender allow/block rules always
  apply, and a Manager release page restores quarantined mail to the inbox.
- An in-app and public support process with trained internal Level 1 triage,
  safe evidence handling, RME Solutions Technology Level 2 escalation, and a
  clear boundary between defects, agreed operational support, and quoted work.
- A current ISO and ITIL alignment map covering information security, service
  management, privacy, continuity, incident response, software quality,
  records, cloud responsibilities, and evidence without claiming certification.
- A public, printable Security & Assurance summary, an in-app deployment
  evidence checklist, and an operator privacy/data-handling guide for managers,
  reviewers, and auditors.
- Recovery-grade D1/R2 backup and isolated-restore guidance plus version-aware
  Worker/Pages rollback procedures for new deployments.
- A Microsoft-style mailbox assignee picker that resolves people through their
  canonical organisational personal mailbox while persisting stable account
  identifiers.
- Durable personal-mailbox ownership and a fail-closed legacy migration that
  quarantines ambiguous records for deliberate operator review.
- Personal rich-text signatures, optional organisation-wide signatures, and
  Manager configure-and-lock controls with protected compose previews.
- A screenshot-led product tour using fictional demonstration data, plus a
  complete feature inventory and dedicated signature operator documentation.
- Standards-aligned High, Normal, and Low message importance across inbound
  parsing, drafts, external providers, Sent copies, and mail views.
- Reply all recipient handling, RFC-style References ancestry, inline MIME image
  rendering, and an RFC 9989-era SPF, DKIM, DMARC, MTA-STS, TLS-RPT, and
  receiver-policy operations guide.
- The official orange Deploy to Cloudflare button with an explicit guided-import
  boundary for the current Pages-plus-Worker monorepo.

### Changed

- Compose no longer asks for confirmation before a message leaves the
  organisation. The warning step added friction without a matching safety
  benefit, so it's gone by design; provider and organisation rate limits can
  still reject a send.
- Signature previews in the editor, compose, and settings now render in a
  pinned light colour scheme, so a signature authored with dark, app-theme
  text no longer disappears against the app's own dark background.
- Admin → Mail trace, Investigate, and Audit log now surface the underlying
  error when a query fails, instead of the same empty state a genuinely
  empty result would show.
- Unavailable recipients now return one neutral, cmail-labelled permanent SMTP
  diagnostic for unknown, disabled, and offboarded addresses. The sender's mail
  system may render its own non-delivery report; cmail sends no autoresponder
  and consumes no outbound quota.
- Account provisioning now requires one personal mailbox on `MAIL_DOMAIN`;
  mailbox delegation is restricted to shared mailboxes and excludes paused,
  offboarded, disabled, ownerless, and wrong-domain identities.
- Offboarding now revokes sessions, invitations, and notification endpoints,
  disables the owned personal mailbox, removes shared-mailbox access, and makes
  published positions internal. Reactivation restores none of those grants.
- Signature layers now render personal then organisation content below the
  sender's text and above quoted history in new messages, replies, and forwards.
- Product security copy now distinguishes cmail controls and guidance from
  authentication policy enforced by the deployed receiving provider.
- Cloudflare production delivery now uses a private Pages service binding to the
  email Worker's native Email Sending binding; the API-token REST path remains
  an optional fallback. Opaque native delivery IDs are stored separately from
  RFC `Message-ID`; a validated REST `result.message_id` is used when present.
- Mixed local/external mail now preserves one canonical visible To/Cc set. The
  Cloudflare REST path uses raw MIME with a separate external SMTP envelope;
  native Cloudflare and Postmark route the complete recipient set through the
  provider so local recipients return through Email Routing exactly once.
- Reply and Forward preserve safely sanitised HTML quotes, Forward omits reply
  headers, expose original parts for deliberate forwarding, and keep Back
  navigation draft-safe. Reply from Sent targets the original recipients, and
  partial REST delivery is surfaced instead of appearing fully successful.

### Security

- Updated the transitive `nanoid` override to 3.3.18 to incorporate the latest
  upstream security fix; the release dependency audit reports no known
  vulnerabilities.
- Added non-enforcing, pseudonymized native Cloudflare inbound abuse signals
  with a separately rate-limited generic alert (at most once per colo/minute);
  these signals never reject mail or avoid recipient/D1 work.
- Unavailable-recipient rejection remains an early, read-only path: it neither
  discloses prior mailbox existence nor parses or stores message content,
  creates per-attempt trace/rate rows, or invokes any outbound provider.
- Mailbox and organisation-management surfaces no longer use or disclose an
  external Google/Microsoft sign-in address as the person's mail identity.
- Personal-mailbox ownership and its Full owner assignment are immutable at the
  database layer; lifecycle and delegation writes recheck eligibility at the
  point of mutation.
- Signature HTML is bounded and sanitised before storage and again before use;
  self-service saves cannot race and overwrite a Manager lock.
- Pinned the patched Nano ID 3.3.17 transitive dependency after the release
  audit identified GHSA-2v37-7h3g-55p8.
- Bounded and validated the private outbound Worker request, kept that Worker
  off public HTTP routes, verified production/preview Wrangler isolation, and
  restricted inline images to authenticated, same-origin safe raster
  attachments.
- Added an immutable D1/R2 outbound journal: provider dispatch is claimed once,
  accepted sends materialize locally with deterministic IDs, ambiguous outcomes
  fail closed, active quota reservations cannot expire underneath recovery,
  confirmed failures release quota atomically, and edited draft generations
  rotate without weakening accepted-send tombstones.

## [0.1.0] - 2026-08-04

### Added

- Generic, environment-driven organisation branding and deployment settings.
- Versioned D1 migrations, local migration verification, automated tests, CI,
  CodeQL analysis, dependency updates, and source/history secret gates.
- Configurable organisation hierarchy and privacy-safe directory controls.
- Google and Microsoft sign-in that appears only when the selected provider is
  completely configured, with immutable provider-subject bindings and
  single-use invitation enrolment.
- Public-project documentation, contribution guidance, issue forms, and
  repeatable Cloudflare setup templates.
- Optional, user-enabled Web Push notifications with generic new-mail payloads
  and no sender, subject, mailbox, address, body, or attachment data.
- Atomic inbound, retained-storage, outbound-work, and draft guardrails that
  fail closed before provider or object-storage work.

### Changed

- Hardened OAuth, sessions, policy acceptance, message permissions, inbound and
  outbound processing, rate limits, idempotency, attachment handling, and error
  responses.
- Reworked mail and administration experiences for accessibility, responsive
  use, and clearer management workflows.

### Security

- Kept deployment credentials, tenant identifiers, and organisation-specific
  material out of reusable templates.
- Added release checks that reject likely credentials in the source tree or
  reachable Git history without printing matched values.
