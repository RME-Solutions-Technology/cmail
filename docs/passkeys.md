# Passkey break-glass sign-in

**Status:** built, off by default, not yet tested against a real tenant, a
live Cloudflare Access application or real phones and security keys. The
tests drive the server with generated credentials (a software authenticator),
not with a browser.

Passkeys let people sign in to cmail when the normal sign-in route is down.
While Microsoft (or Google, an email code or the Cloudflare Access bridge)
works, a signed-in person adds one or more passkeys. If that route later
fails, they open `/auth/passkey` and sign in with a passkey alone. Nothing
from Microsoft, Entra ID or Cloudflare Access takes part in that sign-in.

This is layer 2 of "what if Entra itself is down". Layer 1 is long sessions:
anyone who used cmail recently stays signed in through an outage
(`SESSION_TTL_HOURS` and the Access application session). Passkeys cover the
people whose sessions have lapsed.

## How it works

**Adding a passkey** (Mail > Settings > Passkeys, shown only when the feature
is on):

1. The person must be signed in the normal way, not with a passkey, and the
   session must have been opened in the last 15 minutes
   (`REGISTRATION_FRESH_MINUTES`). Otherwise the page asks them to sign out
   and in again. This stops an old or stolen cmail session cookie from
   planting a passkey that would outlive it. **Limit under Access:** with the
   Access bridge on, signing out and back in can mint a fresh cmail session
   silently from a still-valid Access session, without a new Entra sign-in.
   So behind Access the 15-minute rule proves a live Access session, not a
   fresh password or MFA prompt. The notices to the person and the managers,
   and the newest-passkeys list in Admin, are the backstop.
2. cmail creates a WebAuthn registration challenge, stores it in D1 tied to
   that account and session, and asks the browser for a **discoverable**
   credential (`residentKey: required`) with **user verification required**
   (fingerprint, face or PIN) and attestation `none`.
3. The response is verified on the server with
   [`@simplewebauthn/server`](https://simplewebauthn.dev/docs/packages/server)
   14.0.3 (pinned exactly): challenge, origin (exactly `APP_URL`'s origin),
   RP ID hash (exactly `APP_URL`'s hostname), user presence and verification,
   and the key algorithm (Ed25519, ES256 or RS256 only).
4. The credential is stored with a name the person chooses (up to 64
   characters), the date added and, later, the date last used. Up to 10 per
   person. The person and every active manager are emailed when a passkey is
   added or removed, and the event is audited. Admin > Passkey sign-in lists
   the newest passkeys with the date added.

The WebAuthn user handle given to the authenticator is 32 random bytes, never
an email or account id. An account's later passkeys reuse it.

**Signing in** (`/auth/passkey`):

1. The page asks for a challenge (`POST /auth/passkey/options`). It lists no
   credentials, so the request says nothing about who is signing in.
2. The browser shows the device's passkey picker. The response goes to
   `POST /auth/passkey/verify`.
3. cmail deletes the challenge as it reads it (single use, even if the rest
   fails), finds the credential by id, checks that the authenticator returned
   the user handle stored with it, and verifies the signature, origin, RP ID,
   user presence and user verification.
4. The signature is verified first. The library's own counter check runs
   before its signature check, so cmail switches it off (it passes a stored
   counter of 0, which never rejects) and compares the counter itself once the
   signature is known to be valid: it must go up, unless the authenticator
   always reports 0 (synced passkeys do). A forged response can never raise
   the alarm. A counter that goes backwards on a valid signature points to a
   copied authenticator: the sign-in is refused,
   `auth.passkey_counter_rollback` is audited and the managers are emailed.
   The stored counter moves with a compare-and-set, so two responses racing
   against the same value cannot both succeed.
5. The account must be active. Paused and offboarded accounts are refused.
6. The sign-in country gate runs as for every other sign-in method.
7. A session is minted with the same cap and eviction
   (`MAX_SESSIONS_PER_USER`) and the same policy check as any other sign-in,
   but a short, fixed lifetime: `PASSKEY_SESSION_TTL_HOURS` (default 8, at
   most 72), never extended by use, unlike the sliding `SESSION_TTL_HOURS`.
   It is marked as a passkey session (`sessions.passkey_credential_id`) and
   accepted only on `APP_URL`'s origin, so a copied cookie replayed on the
   `*.pages.dev` address gets nothing. "Last used" is set only once a session
   is actually opened (after the country gate).

Every refusal on the two sign-in endpoints returns the same message, so they
never reveal whether a credential or account exists or why it was refused. The
audit log (`auth.passkey_failed`) records the reason for refusals of a known
passkey. Unknown passkey ids are counted, not logged one by one: an audit row
is written at the 1st, 10th, 100th, 1,000th and 10,000th in an hour. The
country gate is the one exception to the single message: it runs after the
passkey is proven and says why, as for the email code.

**Managers** can sign in with a passkey (it is break-glass). Each manager
passkey sign-in is also audited as `auth.passkey_manager_sign_in`, and every
active manager is emailed.

**Notices.** The person and every active manager are emailed when a passkey is
added or removed; the managers are emailed when a manager signs in with a
passkey, when a counter rollback is seen, and when the switch is turned on or
off. These notices have their own manager-email budget (60 an hour), separate
from the shared one travel requests use, so neither can crowd out the other;
removals are limited to 10 per person per hour. With no outbound provider or
system From address nothing is skipped
silently: each missed notice is audited as `email.failed`, and Admin >
Passkey sign-in shows a warning and the newest-passkeys list to review by
hand.

**What a passkey session cannot do:** add or remove passkeys, or approve a
new AI app (MCP) connection at `/oauth/authorize`, because that grant would
outlive the short break-glass session. It works only for active accounts
(not pending ones).

**A passkey session ends** after `PASSKEY_SESSION_TTL_HOURS` whatever
happens, and earlier when the person signs out, when the passkey is removed
(by them or a manager), when the account is paused or offboarded, and when a
manager turns the feature off.

## Threat model

| Threat | What stops it |
|---|---|
| Phishing site relays the ceremony | WebAuthn binds the response to the origin and RP ID; cmail accepts only `APP_URL`'s exact origin and hostname. The `*.pages.dev` address gets 404. |
| Replayed response | Challenges are server-side, single use (deleted when read) and expire after 5 minutes. |
| Cloned hardware key | Signature counter must increase; a rollback is refused, audited and emailed to managers. |
| Stolen phone or key | User verification is required (biometric or PIN). A manager removes the person's passkeys in Admin, which also ends their passkey sessions. |
| Stolen session cookie used to plant a passkey | Adding needs an ordinary (non-passkey) session opened in the last 15 minutes. The person and every manager are emailed when a passkey is added, and Admin lists the newest passkeys. Behind Access a fresh session can be minted silently (see "Adding a passkey"), so the notices are the main control there. |
| Passkey session used to add more passkeys | Refused: adding or removing your own passkeys needs an ordinary session. |
| Account enumeration | No credential list in the challenge; one message for every refusal; the user handle is random. |
| Online guessing or flooding | Per address (IPv4, or IPv6 per /64): 30 challenges per 10 minutes, and 10 **failed** sign-ins per 10 minutes (successes never count, so an office NAT is not locked out during an outage). Per passkey: 20 sign-ins with a valid signature per hour, counted only after the signature checks out, so nobody without the passkey can use it up. No global cap, so one host cannot lock everyone out. Refusals with no known passkey are not audited one by one, and a rate limit is audited once when it is hit, so the audit log cannot be flooded. Expired challenges are deleted by the normal maintenance sweep. |
| Replayed passkey session cookie on another hostname | Passkey sessions are accepted only on `APP_URL`'s origin; on `*.pages.dev` they give nothing. |
| A passkey session left open | Fixed 8-hour lifetime (`PASSKEY_SESSION_TTL_HOURS`), never renewed by use. |
| Leaver keeps access | Paused and offboarded accounts cannot sign in, and pausing ends their sessions. |
| Manager misuse | Allowed for break-glass, but audited separately and emailed to all managers. |
| Passkey sessions weakening the Access gate | See below: only a session minted by a verified passkey skips the Access token check, and only while the feature is on and the passkey still exists. |

Not covered: an attacker who controls the person's unlocked device, or a
malicious browser extension on it. That is true of every sign-in method.

## Cloudflare Access

With the [Access bridge](staff-sign-in.md#cloudflare-access-bridge) on, cmail
fails closed: a request without a valid Access token gets no session, even
with a valid cmail cookie. Passkey sessions are the one exception, by design:

- A **passkey session** (marked by `sessions.passkey_credential_id`) is used
  without an Access token, and also when the bridge is misconfigured. It is
  still checked on every request: the feature must be on, the passkey must
  still belong to the account and the account must be active.
- If a valid Access token for the **same** person arrives with a passkey
  session, the session is used as is.
- If a valid Access token for **someone else** arrives, the passkey session is
  set aside for that request (cookie kept) and Access signs the token's
  person in as usual. Only when Access does sign them in, replacing the
  browser's cookie, is the set-aside passkey session revoked, because it can
  no longer be used. An ordinary session in the same position is revoked, as
  before.
- A passkey session is used only on `APP_URL`'s origin. It is never renewed
  by use.
- Every other session keeps the bridge's rules unchanged. `/auth/passkey`
  never opens a session from an Access token.

Tests: `apps/web/src/lib/server/passkeys.test.ts`, "hooks: passkey sessions
and the Access bridge".

### The one path to exclude from Access

Exclude only `/auth/passkey` (and its sub-paths). Everything else stays behind
Access. Cloudflare picks the most specific application path and does not
inherit rules from the broader one
([Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)),
so a separate application for this path with a Bypass policy works
([Bypass](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/#bypass)):

1. Cloudflare dashboard > **Zero Trust** > **Access controls** >
   **Applications** > **Create new application** > **Self-hosted and
   private**.
2. **Add public hostname**: the cmail subdomain and domain (for example
   `mail` + `example.com`), path `auth/passkey`. Add a second public hostname
   with the same subdomain and domain and path `auth/passkey/*`, so the
   sub-paths match whichever way the path is read.
3. Name it, for example "cmail passkey sign-in".
4. **Access policies** > create a policy: action **Bypass**, include
   **Everyone**. Optionally add a **Require** rule on country to narrow it.
5. Save. Check: in a private window, `https://mail.example.com/auth/passkey`
   shows the passkey page (once the feature is on) without an Access login,
   and `https://mail.example.com/mail` still goes to the Access login.

The page is built to need nothing outside `/auth/passkey`: its only script is
`/auth/passkey/client.js`, its styles are inline, and it loads no app bundle,
font or logo (those stay behind Access). Its own Content-Security-Policy
allows same-origin script and connections only.

Bypass turns off Access enforcement and logging for that path. cmail's own
checks (rate limits, single-use challenges, origin and RP ID) protect it.

### During an outage: opening the mail pages

Excluding `/auth/passkey` lets people sign in, but `/mail` and the rest of the
site are still behind Access. If Entra ID is down, Access cannot sign anyone
in, so a passkey user would sign in and then be stopped at the Access login on
`/mail`. Cloudflare Access cannot see cmail's cookie, so it cannot tell a
passkey session apart at the edge.

So break-glass has one deliberate step by a person, taken only when Entra
sign-in is actually failing:

1. A Cloudflare account member signs in to the Cloudflare dashboard. **Their
   dashboard login must not depend on Entra ID** (use Cloudflare's own login
   with two-factor authentication, not SSO through Entra). Check this before
   you need it.
2. In the main cmail Access application, add a policy: action **Bypass**,
   include **Everyone** (optionally require a country), and move it to the
   top. Save.
3. Tell people to sign in at `https://mail.example.com/auth/passkey`.
4. While the gate is open, cmail still fails closed for everything except
   passkey sessions: ordinary and Access-bridge sessions need a valid Access
   token, and the passkey page is the only working sign-in. If Access sends
   no token on bypassed requests (cmail does not rely on it either way),
   people who still have an Access session but no passkey are signed out
   until the gate closes.
5. When Entra ID works again, delete the Bypass policy from the main
   application.

**What the outage Bypass also exposes.** While the main application bypasses
Access, every path reaches cmail without Access, not only the mail pages:

- AI app (MCP) paths: `/mcp`, `/oauth/*` and `/.well-known/*`. They still need
  cmail's own OAuth bearer tokens, but they lose Access in front of them.
- `/bootstrap`, which is refused once a manager exists, but is better not
  reachable at all.
- `/enroll/*` invitation links, which still need a valid single-use
  invitation token.

To keep those behind Access during the Bypass, create one more self-hosted
Access application now, before any outage, covering exactly those paths
(`mcp`, `mcp/*`, `oauth/*`, `.well-known/*`, `bootstrap`, `enroll/*` on the
cmail hostname) with your normal Allow policy, or a **Block** policy if you
do not use them. Access picks the most specific application path, so this
application keeps applying while the main one bypasses. Also leave AI app
connections off in Admin > Settings unless you need them, and remove
`BOOTSTRAP_ADMIN_TOKEN` once the first manager exists.

Prepare it: write the policy as a reusable policy in advance and practise
adding and removing it, so the step takes a minute. Opening the gate is the
last resort; layer 1 (long sessions) covers most outages without it.

## Set up

1. Apply migration `0025` (`pnpm db:migrate`). It adds `passkey_credentials`,
   `passkey_challenges` and the nullable `sessions.passkey_credential_id`
   column. Additive: no existing row changes.
2. Make sure `APP_URL` is the site's https address (for example
   `https://mail.example.com`). Passkeys are bound to that hostname: changing
   it later makes every passkey stop working.
3. Admin > **Passkey sign-in** > **Turn passkey sign-in on**. The button stays
   off until the migration is applied and `APP_URL` is valid.
4. If the site is behind Cloudflare Access, add the `/auth/passkey` Bypass
   application above and prepare the outage step.
5. Ask people to add a passkey (Mail > Settings > Passkeys) and to bookmark
   `/auth/passkey`. Ask them to try it once.

Off by default. When off, `/auth/passkey`, `/auth/passkey/client.js`, the
sign-in and registration endpoints answer 404, the settings page and the
"Use a passkey" link are hidden, and every passkey session is refused.
Turning it off also signs out all passkey sessions. Registered passkeys are
kept for when it is turned on again.

## Recovery

- **One device lost or stolen:** the person removes that passkey in Mail >
  Settings > Passkeys (signed in the normal way), or a manager removes all of
  their passkeys in Admin > Passkey sign-in. Either ends the passkey sessions
  those passkeys opened.
- **All passkeys lost, normal sign-in works:** nothing is lost. A manager
  removes the old passkeys if the devices may be in someone else's hands; the
  person adds new ones after signing in the normal way.
- **All passkeys lost during an outage:** the person cannot sign in until the
  normal route returns. There is no fallback by design: an email link would
  go to the mailbox that is unavailable, and a manager override would be a
  way around the passkey. Encourage everyone to add two passkeys (for example
  phone and laptop, or a synced passkey and a security key).
- **Every manager's passkeys lost during an outage:** people with passkeys can
  still sign in and read mail, but nobody can use Admin until a manager signs
  in the normal way. Managers should each keep two passkeys.
- **A passkey may be copied** (`auth.passkey_counter_rollback` in the audit
  log): remove that person's passkeys in Admin and ask them to add new ones.
- **Turn it all off:** Admin > Passkey sign-in > **Turn passkey sign-in off**
  ends every passkey session at once.

## Audit events

| Event | When |
|---|---|
| `auth.passkey_registered` | A passkey was added (with its name) |
| `auth.passkey_register_failed` | A registration response failed verification |
| `auth.passkey_removed` | A person removed a passkey, or a manager removed all of someone's |
| `auth.sign_in` | "Signed in via passkey ..." for every passkey sign-in, with the session id |
| `auth.passkey_manager_sign_in` | A manager signed in with a passkey (managers are emailed) |
| `auth.passkey_failed` | A refused sign-in, with the reason |
| `auth.passkey_counter_rollback` | Counter went backwards: possible copied passkey (managers are emailed) |
| `auth.sign_in_denied` | Country gate refused a proven passkey |
| `security.rate_limit` | A passkey rate limit was hit |
| `org.passkey_signin_toggled` | A manager turned the feature on or off |

## Code

- `apps/web/src/lib/server/passkeys.ts`: relying party, switch, challenges,
  registration, sign-in, session check, admin actions.
- `apps/web/src/lib/server/passkey-signin-page.ts`: the self-contained sign-in
  page and its script.
- `apps/web/src/routes/auth/passkey/`: the page, `client.js`, `options` and
  `verify`.
- `apps/web/src/routes/api/passkeys/register/`: registration endpoints.
- `apps/web/src/routes/mail/passkeys/`: Mail > Settings > Passkeys.
- `apps/web/src/routes/admin/passkeys/`: Admin > Passkey sign-in.
- `apps/web/src/hooks.server.ts`: passkey sessions and the Access bridge.
- `packages/shared/migrations/0025_passkeys.sql`.

## References

- W3C, [Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/):
  discoverable credentials, user verification, the signature counter and the
  user handle.
- [SimpleWebAuthn server docs](https://simplewebauthn.dev/docs/packages/server).
  It runs on Web Crypto (`globalThis.crypto`) with no Node built-ins. Its
  changelog calls Cloudflare Workers "periodically tested but unofficially
  supported", so the passkey tests and the CI build are the check here.
- Cloudflare, [Access policies: Bypass](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/#bypass)
  and [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).
- Cloudflare, [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/):
  enforced by default, which the `ON DELETE CASCADE` on passkey sessions
  relies on (cmail also revokes those sessions itself).

## Not yet verified

- Real devices: iPhone, Android, Windows Hello, macOS and a FIDO2 security
  key, in Safari, Chrome, Edge and Firefox.
- The Access Bypass application for `/auth/passkey` on a live Zero Trust
  account, and whether Access sends a token on bypassed requests.
- Runtime behaviour of `@simplewebauthn/server` on Cloudflare Pages itself:
  the tests run on Node's Web Crypto (ES256, Ed25519 and RS256 are all
  covered there). Size, measured on a local `pnpm build` (15 Nov 2026): the
  library bundles to 321 KB minified, 88 KB gzip; the whole server output is
  about 1.3 MB gzip, within the Pages Functions limits (3 MB free, 10 MB
  paid).
- That an Access application on a sub-path keeps applying while the main
  application has a Bypass policy (Cloudflare documents the path precedence;
  not tried on a live account).
