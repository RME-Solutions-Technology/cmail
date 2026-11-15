# Staff portal sign-in contract

A staff portal can link to `APP_URL` + `/mail`. An existing, valid cmail
session opens the user's assigned mailboxes. A signed-out browser with a
remembered cmail provider starts fresh OAuth; otherwise it reaches the normal
sign-in page. The portal sends no identity headers, credentials,
email address, role, or mailbox identifier. cmail owns its session cookie,
policy acceptance, account status, and mailbox authorization.
The portal may show this link to all authenticated staff when a mail origin
is configured, without maintaining a duplicate mailbox-enabled flag. Link
visibility grants no cmail account, role, or mailbox access.

For a portal that explicitly offers a configured provider, optional shortcuts
are `APP_URL` + `/auth/login/google?sso=1` and
`APP_URL` + `/auth/login/microsoft?sso=1`. These are browser navigation URLs,
not token-exchange APIs. A portal may choose one from its actual authenticated
staff-session provider, but this grants no cmail eligibility: cmail still
requires its own exact provider-subject binding. Never infer the provider from
email or treat Access admission as that binding. Keep `/mail` as the neutral
mailbox card destination; signed-out `/` deliberately remains the chooser.

Google and Microsoft are supported providers, not a promise that both are
enabled in a deployment. The chooser shows only providers with configured
client credentials; a Microsoft tenant setting alone does not enable Microsoft.
The existing email-code sign-in link and its eligibility checks remain available
and unchanged. Email-code sign-in does not save an OAuth provider preference.

The shortcut reuses a validated cmail session when present. Otherwise it
starts the ordinary authorization-code flow, with fresh state and S256 PKCE,
but omits the forced account chooser. The provider may still require login,
consent, MFA, or account selection. This does not promise silent sign-in.
Ordinary sign-in links and requests carrying enrollment/bootstrap intent
retain `prompt=select_account`. No query-string redirect or identity hint is
forwarded. Errors return to the normal sign-in page; there is no automatic
retry loop. To choose another account, use its normal sign-in button.

After a successful returning-account OAuth callback over HTTPS, cmail saves
only `google` or `microsoft` in `__Host-cmail_last_provider` for 30 days. It is
host-only, HttpOnly, Secure, SameSite=Lax, and contains no account identifier.
First enrollment and bootstrap do not set it. A direct signed-out `GET /mail`
may use this untrusted preference to start the configured provider's `?sso=1`
flow with fresh state/PKCE. It never establishes a session itself. Invalid,
absent, or disabled preferences, enrollment/bootstrap intent, background page
data requests, and deep links retain the chooser path. Explicit logout clears
the preference even when the cmail session has already expired. OAuth failure
returns to `/`, where the preference cannot trigger an automatic retry.

## Identity and Access boundary

Returning OAuth sign-in resolves `user_identities(provider, subject)` from
access-token-backed UserInfo. Google uses
`https://openidconnect.googleapis.com/v1/userinfo`; Microsoft uses
`https://graph.microsoft.com/oidc/userinfo`. There is no stored issuer column
or generic JWT/ID-token issuer validator in this flow: the provider namespace
is fixed by server-selected endpoints and the configured OAuth application.
Do not change the OAuth client registration as a shortcut to federation.

Cloudflare Access can be an extra edge gate in front of any of these flows.
With the optional Access bridge below turned on, it can also sign people in.
Access `sub` is an Access user identifier; Microsoft's `sub` is
application-specific, so neither an Access subject nor a subject from another
Microsoft application is ever substituted for cmail's existing provider
subject. The bridge stores the Access subject as its own identity,
`user_identities('access', sub)`. See the [Access application-token reference](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
and [Microsoft claim reference](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference).

An email header, Access service token, or portal role cannot grant mail
access or manager status. Invitation, bootstrap proof/nonce, callback
state/PKCE, CSRF, country gates, session revocation, roles, and mailbox
assignments remain in force.

## Cloudflare Access bridge

Optional, off by default. Set `ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`)
and `ACCESS_AUD` (the Access application's AUD tag) to turn it on.

**Token check.** On every request cmail reads `Cf-Access-Jwt-Assertion` and
accepts it only if all of these hold:

- the header names `alg` `RS256` (no `none`, no HMAC, no other algorithm)
  and a `kid` found in `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`;
- the RS256 signature verifies against that key;
- `iss` is exactly `https://<team>.cloudflareaccess.com`;
- `aud` contains `ACCESS_AUD`;
- `exp` has not passed and `nbf` / `iat` are not in the future, each with
  60 seconds of clock skew; a token with no `exp` is refused;
- `type`, when present, is `app`, and the token carries a non-empty `sub` and
  a valid `email`. Service tokens have neither, so they never open a mailbox.

Keys are cached per isolate for an hour. The certs endpoint is fetched at
most once every 30 seconds, whatever the reason (an unknown `kid`, a stale
cache or a failing endpoint). If it is down, cached keys keep working for up
to 24 hours; with no usable key, every token is refused.

**Fail closed.** With the bridge on, a request without a valid token gets no
session, even with a valid cmail cookie. A cookie session is used only when
its account is bound to the token's `sub`. If the account has no Access
binding yet and its email matches the token, the binding is made then (this is
how a manager or an existing Google/Microsoft user links). Otherwise the
session belongs to someone else: it is revoked and ignored. If only one of the
two variables is set, or either is invalid, every request is signed out and
the error is logged once per isolate.

**Binding.** An Access identity opens a session (on an ordinary page `GET`,
not `/bootstrap`, `/enroll/*`, `/auth/*`, `/mcp` or the OAuth machine
endpoints) as follows:

1. A returning visit is looked up by Access `sub` only. If the token's email no
   longer matches the account, the binding stays and an
   `auth.access_email_changed` audit entry is written.
2. A first visit may adopt an existing account by verified email only when
   that account has no sign-in identity at all: an invited account that never
   enrolled, or a synced account. It must be a standard account that is
   pending or active. Adoption is refused when the account is paused or
   offboarded, already has a different Access `sub`, is a manager, or already
   signs in with Google, Microsoft or an email code. Those people, managers
   included, link by signing in once the normal way while behind Access: the
   request then carries both their cmail session and a matching Access token,
   and the binding is made.
3. With `ACCESS_AUTO_PROVISION=true`, an email on `MAIL_DOMAIN` with no account
   gets a standard account and a personal mailbox at that address. Emails on
   other domains, and addresses already used by any mailbox, are refused.
   Managers are never created this way.
4. Nothing is bound or created before the first manager exists. The first
   manager still uses `/bootstrap`.

The sign-in country gate runs before any binding, activation or account
creation, so a refused country changes nothing. Each account holds at most
one Access binding and one Access `sub` belongs to one account (migration
`0021`). Policy acceptance and the audit trail work as for OAuth sign-in.
Repeated denials (`auth.sign_in_denied`) and email-change notes are audited
once per person and reason every 10 minutes.

A session and cookie are minted only when the request has no valid cmail
cookie, so each browser or device signs in once and then reuses its own
cookie. Minting follows the normal sign-in rules: one `auth.sign_in` row,
and the oldest sessions beyond `MAX_SESSIONS_PER_USER` are signed out,
exactly as for a Google or Microsoft sign-in.

Sign-out also ends the Access session (`/cdn-cgi/access/logout`); otherwise
Access would sign the user straight back in.

**Resetting a binding.** Cloudflare gives a person a new `sub` when they are
removed from and re-added to the Zero Trust organisation. Their old binding
then makes every visit fail with an identity conflict. A manager fixes this
in **Admin > Users > Reset Access link**: it removes the Access binding (not
the person's other sign-in identity), signs out their sessions, and writes an
`auth.identity_reset` audit entry. The next Access visit binds again under the
rules above.

An Access-bound account cannot later accept a Google, Microsoft or email
invitation: the invitation reports an identity conflict, as for any account
that already has a binding.

**Rollout.**

1. Apply migration `0021` (`pnpm db:migrate`).
2. Create a self-hosted Access application for the cmail hostname. Put the
   direct `*.pages.dev` hostname behind the same application (or block it), so
   no request reaches cmail without Access.
3. Add the policy: "emails ending in @domain" with your identity provider, or
   an identity-provider group. cmail does not re-check groups: Access decides
   who enters, cmail decides which mailbox they get.
4. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, and optionally
   `ACCESS_AUTO_PROVISION`, then redeploy.
5. Session length: the Access application session and `SESSION_TTL_HOURS`
   both limit how long someone stays signed in. Both need a valid Access token
   on each request.

**Bearer-token paths are outside the bridge.** AI app (MCP) connections
(`/mcp`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`,
`/.well-known/*`) authenticate with their own OAuth bearer tokens, not with
the Access token or a cmail cookie, and the bridge leaves them unchanged
(a test covers this). They never get a session from Access. Choose one per
deployment:

- leave AI app connections off (the default in Admin > Settings); or
- if they are on and Access covers the whole hostname, add an Access policy
  for those paths (for example a service-token or Bypass policy scoped to
  them), because AI clients cannot complete an interactive Access login.

Turning a person off in Access does not revoke their AI app grants. When
someone leaves, also pause or offboard them in cmail: both revoke every MCP
token and grant they hold. Remove them in Access too.

## Live configuration still needs verification

- Confirm the mail origin and existing provider configuration in each lane.
  Register exactly `APP_URL` + `/auth/callback/google` and/or
  `/auth/callback/microsoft` on the corresponding existing OAuth application.
- Verify the intended staff account already has its provider binding and
  mailbox assignment. New users use the existing manager invitation flow.
  The OAuth flows add no automatic provisioning, merging, or email-based
  linking; only the Access bridge, when configured, binds by verified email
  on a first visit and can provision.
- If Access protects mail, review its own application audience, issuer,
  allowed staff/IdP policy, MFA/session requirements, and protection of both
  custom and direct Pages origins. Keep preview isolated. Without the bridge
  variables, Access admission alone does not establish cmail eligibility.
- Rehearse browser behavior with the same provider session, multiple accounts,
  signed-out providers, rejected consent, revoked/paused accounts, and pending
  policy acceptance. Provider session reuse depends on browser and IdP policy.

No migration, new secret, provider registration change, or Access setting is
required by the optional shortcut itself. The Access bridge needs migration
`0021` and the Access application described above. Local tests do not verify live
configuration or authorize deployment.
