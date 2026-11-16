---
title: "Credentials and permissions"
summary: "Every token, app registration and secret cmail uses, with the exact permissions, where each is stored, who holds it and how to rotate it."
applies_to: both
audience: [operator, reviewer]
switch: none
last_reviewed: 2026-11-16
related: [configuration.md, operations.md, onboarding-microsoft-365.md, glossary.md]
---

# Credentials and permissions

This is the one list of every credential cmail uses. Each feature page has
the setup steps; this page says what to create, with which permissions,
and where it goes. Give each credential the least access in its row and
nothing more.

**In this article**

- [Which credentials you need](#which-credentials-you-need)
- [Cloudflare API tokens](#cloudflare-api-tokens)
- [Microsoft Entra apps](#microsoft-entra-apps)
- [Other providers](#other-providers)
- [Worker and Pages secrets](#worker-and-pages-secrets)
- [How to store a secret](#how-to-store-a-secret)
- [How to rotate a credential](#how-to-rotate-a-credential)
- [Troubleshoot credential errors](#troubleshoot-credential-errors)
- [Sources](#sources)

**Who holds what.** The *operator* runs the cmail instance: the Cloudflare
account, Wrangler and the Worker and Pages secrets. The *client admin* runs
the organisation's Microsoft 365 tenant and creates or consents to the
Entra apps. One person can be both. No credential is ever stored in the
repository, in `wrangler.toml` `[vars]`, in a ticket or on a command line
saved in shell history.

## Which credentials you need

| You want | You need |
|---|---|
| Primary mail for your organisation | A Wrangler login or [deploy token](#deploy-token-wrangler), a sign-in app (Google or Microsoft), `SESSION_SECRET`, `INBOUND_SENDER_HASH_KEY`, and the one-time bootstrap pair. Optional: the REST fallback and Unblock tokens, Postmark, Turnstile, VAPID. |
| Microsoft 365 standby | All of the above with the Microsoft sign-in app, plus whichever standby features you turn on: the [sync app](#microsoft-365-sync-app), the [permission reader](#shared-mailbox-permission-reader), the [copy-back app](#copy-back-app), the [journal address](#exchange-journal-rule-no-app) and the [standby switch token](#standby-switch-token). |

Every standby feature is off by default and has its own Admin switch. A
credential for a feature you have not turned on can stay unset.

## Cloudflare API tokens

Create account-owned tokens where you can (Manage Account > Account API
Tokens), so a token does not depend on one person's login. Scope each to the
one account and, for zone permissions, the one zone. The dashboard shows
permissions as **Read** and **Edit**; the API reference calls Edit
**Write** (for example "DNS Write"). They are the same permission.

| Token | Used by | Permissions (dashboard names) | Scope | Stored | Held by | Rotate |
|---|---|---|---|---|---|---|
| <a id="deploy-token-wrangler"></a>Deploy token (Wrangler) | `pnpm deploy:*`, `wrangler secret put`, `pnpm db:migrate`, `wrangler tail`, the onboarding scripts | Account > Workers Scripts > Edit; Account > Workers Tail > Read; Account > Cloudflare Pages > Edit; Account > D1 > Edit; Account > Workers R2 Storage > Edit; Account > Account Settings > Read. For bounce feedback add Account > Queues > Edit (`wrangler queues create` and the Email Sending event subscription). For shared mailbox access add Account > Containers > Edit (see the note below). | The instance's account | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the operator's session only. Or skip the token and use `wrangler login`. | Operator | On your schedule, and when someone with access leaves |
| `CLOUDFLARE_EMAIL_API_TOKEN` | REST send fallback (`POST /accounts/{id}/email/sending/send` and `send_raw`) | Account > Email Sending > Edit | The instance's account | Pages secret, with the account ID in the Pages var `CLOUDFLARE_ACCOUNT_ID` | Operator | On your schedule; see [Rotate secrets](operations.md#rotate-secrets) |
| `CLOUDFLARE_SUPPRESSIONS_API_TOKEN` | **Unblock and send again** on a blocked recipient (`GET` and `DELETE /accounts/{id}/email/sending/suppressions`) | Account > Email Sending > Edit | The instance's account | Pages secret, with the account ID in the Pages var `CLOUDFLARE_ACCOUNT_ID` | Operator | On your schedule; see [Rotate secrets](operations.md#rotate-secrets) |
| <a id="standby-switch-token"></a>Standby switch token | `scripts/standby/switch.mjs` and `switch-back.mjs` | Dry run: Zone > Zone > Read; Zone > DNS > Read; Zone > Zone Settings > Read; Zone > Email Routing Rules > Read. `--apply` adds Zone > DNS > Edit; switch-back `--apply` may add Zone > Zone Settings > Edit (to unlock Email Routing's records). `--probe-d1` adds Account > D1 > Read. | The one mail zone (and the account, for D1) | `CLOUDFLARE_API_TOKEN` in the session only, typed with a hidden prompt | Operator; the write version only for people allowed to change DNS | After each drill or switch |
| R2 backup token (optional) | Manual off-site copies with `rclone` ([Back up and rehearse recovery](deployment.md#back-up-and-rehearse-recovery)) | R2 API token: Object Read only | The mail bucket only | The backup tool's own config, outside git | Operator | On your schedule |

**Both Email Sending tokens have the same permission but separate jobs.**
The send token can send mail from every onboarded domain in the account, so
the Unblock button has its own token and turning it on never changes how
mail is sent. The default send path uses the email Worker's `send_email`
binding and needs no token at all.

**No token, done in the dashboard.** Email Routing rules (the catch-all to
the email Worker, the [standby test address](standby-probe.md) rules on the
subdomain, the [Exchange mirror](exchange-mirror.md) journal address rule),
Email Sending domain onboarding, the Pages custom domain and the
[Cloudflare Access](staff-sign-in.md#cloudflare-access-bridge) application
are set up by a person in the dashboard. cmail never needs Email Routing or
Access permissions at run time.

**Not verified.** Cloudflare's docs do not name the permission that
`wrangler deploy` needs for a container, nor the one for creating an Email
Sending event subscription. Containers > Edit and Queues > Edit are inferred
from the permission list and have not been confirmed with a token that had
only them. Cloudflare documents that deploying a Worker with bindings needs
only Workers Scripts access, not access to the bound resources
([Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/#bindings)).
Workers Tail > Read is part of Cloudflare's "Edit Cloudflare Workers" token
template ([API token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/)).

## Microsoft Entra apps

Use a **separate app for each job**, so a leaked secret from one can never
do another's work. All are single tenant. Placeholders: tenant ID
`00000000-0000-0000-0000-000000000000`, initial domain
`example.onmicrosoft.com`.

| App | Feature | Permissions | Consent | Credential and where it goes | Role needed to set it up | Setup |
|---|---|---|---|---|---|---|
| Sign-in app | Microsoft sign-in, staff sign-in | Microsoft Graph, **delegated**: `openid`, `email`, `profile`. Nothing else. | No admin consent required. Users can usually consent themselves; an Application Administrator can consent for everyone | Client secret: Pages secret `MICROSOFT_CLIENT_SECRET`; `MICROSOFT_CLIENT_ID` (Pages secret) and `MICROSOFT_TENANT_ID` (Pages var) | Application Administrator, Cloud Application Administrator or the app owner. Global Administrator is not needed | [Onboarding step 3](onboarding-microsoft-365.md#3-sign-in-app), `new-signin-app.ps1` |
| <a id="microsoft-365-sync-app"></a>Sync app | [Microsoft 365 sync](m365-sync.md), shared mailbox detection, group expansion for shared mailbox access | Microsoft Graph, **application**: `User.Read.All`. Add `MailboxSettings.Read` only with `M365_DETECT_SHARED_MAILBOXES = "true"`; add `GroupMember.Read.All` only with a scope or shared group, or for shared mailbox access group grants. Read only. | **Admin consent** for the tenant | Client secret: Worker secret `M365_CLIENT_SECRET`; `M365_TENANT_ID` and `M365_CLIENT_ID` are Worker vars, and `M365_TENANT_ID` is also a Pages var so synced staff can sign in with Microsoft | Global Administrator, or Privileged Role Administrator with (Cloud) Application Administrator (the latter not verified) | [Onboarding step 5](onboarding-microsoft-365.md#5-microsoft-365-sync), `new-sync-app.ps1` |
| <a id="shared-mailbox-permission-reader"></a>Permission reader | [Shared mailbox access](m365-mailbox-permissions.md) | Office 365 Exchange Online, **application**: `Exchange.ManageAsApp`. Remove the default Graph `User.Read`. In Exchange: a custom role group holding only `Get-Mailbox`, `Get-MailboxPermission`, `Get-RecipientPermission`, `Get-Recipient`, `Get-User`, `Get-Group`. | **Admin consent** for `Exchange.ManageAsApp` | Certificate (no client secret): Worker secrets `M365_EXO_CERT_PFX_B64` and `M365_EXO_CERT_PASSWORD`; `M365_EXO_APP_ID` and `M365_EXO_ORGANIZATION` are Worker vars | Global Administrator for consent; Exchange Administrator for the role group | [Onboarding step 11](onboarding-microsoft-365.md#11-shared-mailbox-permissions-optional), `perms-setup.ps1` |
| <a id="copy-back-app"></a>Copy-back app | [Copy standby mail back into Exchange](copy-back.md) | **No** Entra API permission and no admin consent for any mail permission. Exchange RBAC for Applications grants the role `Application Mail.ReadWrite` scoped to a mail-enabled group. An Entra-consented `Mail.ReadWrite` would cover every mailbox in the tenant. | None in Entra; the scoped Exchange role assignment instead | Client secret: Worker secret `M365_COPYBACK_CLIENT_SECRET`; `M365_COPYBACK_CLIENT_ID` and `M365_TENANT_ID` are Worker vars | Application Administrator to create it; Exchange Organization Management (Exchange Administrator has it) for the role assignment | [Copy-back setup](copy-back.md) |
| <a id="exchange-journal-rule-no-app"></a>Exchange journal rule (no app) | [Exchange mirror](exchange-mirror.md) | No app. One journal rule sends journal reports to a secret address routed to the email Worker. | None | The journal address is the secret: Worker secret `M365_JOURNAL_ADDRESS` | Exchange Administrator (or Global Administrator) | [Onboarding step 10](onboarding-microsoft-365.md#10-exchange-mirror-optional), `exchange-mirror.ps1` |

Resource application IDs, for scripts and checks: Microsoft Graph
`00000003-0000-0000-c000-000000000000`; Office 365 Exchange Online
`00000002-0000-0ff1-ce00-000000000000`. The onboarding scripts look up each
permission's ID by name, so no permission GUIDs are hard-coded.

**PIM.** If these roles are eligible in Privileged Identity Management,
activate them first, wait a minute, then run `az login` again; `az` keeps
the roles it had at sign-in. See [Onboarding: what you need
first](onboarding-microsoft-365.md#0-what-you-need-first).

**Expiry.** Client secrets and the certificate expire. Record each expiry
in your secrets register and renew before it. An expired sync secret stops
the sync (`unauthorized`); an expired reader certificate stops the
collector (`credentials_rejected`); access already in cmail stays as it is.

## Other providers

| Credential | Feature | Permissions | Stored |
|---|---|---|---|
| Google OAuth client | Google sign-in | Scopes `openid`, `email`, `profile` | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, Pages secrets |
| Postmark server token | Postmark outbound (alternative to Cloudflare) | One Postmark server | `POSTMARK_API_KEY`, Pages secret |
| Turnstile secret | Optional bot check on the email-code form | One Turnstile widget | `TURNSTILE_SECRET_KEY`, Pages secret; `TURNSTILE_SITE_KEY` is a Pages var |

## Worker and Pages secrets

Secrets you generate yourself (random values) and secrets from the
providers above. "Worker" is the email Worker
(`apps/email-worker/wrangler.toml`); "Pages" is the web app.

| Name | Where | Required | Feature |
|---|---|---|---|
| `SESSION_SECRET` | Pages | Yes | Sessions; a random value per environment |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Pages | One sign-in provider is required | Google sign-in |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Pages | One sign-in provider is required | Microsoft sign-in |
| `INBOUND_SENDER_HASH_KEY` | Worker | Yes | Per-sender inbound limits |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_TOKEN` | Pages | Only until the first manager exists; then delete both | [First manager](deployment.md#9-bootstrap-and-lock-down-administration) |
| `VAPID_PRIVATE_KEY` | Pages and Worker (same value) | Optional | Browser notifications |
| `TURNSTILE_SECRET_KEY` | Pages | Optional | Email-code bot check |
| `POSTMARK_API_KEY` | Pages | Optional | Postmark outbound |
| `CLOUDFLARE_EMAIL_API_TOKEN` | Pages | Optional | REST send fallback |
| `CLOUDFLARE_SUPPRESSIONS_API_TOKEN` | Pages | Optional | Unblock and send again |
| `M365_CLIENT_SECRET` | Worker | For the sync | [Microsoft 365 sync](m365-sync.md) |
| `M365_EXO_CERT_PFX_B64`, `M365_EXO_CERT_PASSWORD` | Worker | For shared mailbox access | [Shared mailbox access](m365-mailbox-permissions.md) |
| `M365_COPYBACK_CLIENT_SECRET` | Worker | For copy-back | [Copy-back](copy-back.md) |
| `M365_JOURNAL_ADDRESS` | Worker | For the Exchange mirror | [Exchange mirror](exchange-mirror.md) |

Non-secret settings (`APP_URL`, `MAIL_DOMAIN`, `M365_TENANT_ID`,
`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and the rest) are in the
[Configuration reference](configuration.md).

## How to store a secret

Each command prompts for the value, so it never appears on screen or in shell history. To pipe it in instead, use `<command that prints the value> | <the command below>`:

```sh
pnpm exec wrangler pages secret put SESSION_SECRET --project-name cmail-web
pnpm exec wrangler secret put M365_CLIENT_SECRET --config apps/email-worker/wrangler.toml --env=""
```

Wrangler prompts for the value. The onboarding scripts pipe each secret from
the tool that made it straight into Wrangler. Pass `--env=""` when the
instance's `wrangler.toml` has an `[env.preview]` section. Set a session
token with a hidden prompt:

```powershell
$env:CLOUDFLARE_API_TOKEN = Read-Host -MaskInput 'Cloudflare token'
```

## How to rotate a credential

1. Create the new value first (new token, client secret or certificate).
2. Store it with the same command as the first time; redeploy Pages.
3. Test the feature: sign in, send a test message, or run the feature's
   **Sync now** or dry run in Admin.
4. Then delete the old value at the provider.

What each rotation breaks, secret by secret, is in
[Running cmail: Rotate secrets](operations.md#rotate-secrets).

## Troubleshoot credential errors

| You see | Cause | Fix |
|---|---|---|
| Wrangler: `Authentication error [code: 10000]` | The token lacks a permission for that command, or targets another account | Check the deploy token row above and `CLOUDFLARE_ACCOUNT_ID` |
| `Set CLOUDFLARE_API_TOKEN in the environment (not on the command line).` | Standby script run without a session token | Set it with a hidden prompt, as above |
| `CLOUDFLARE_API_TOKEN is not set or does not look like an API token.` | Empty or malformed token in the session | Paste the token again |
| Admin > Microsoft 365 sync: `error (unauthorized)` | Sync secret expired, or admin consent removed | New secret, or grant consent again ([m365-sync.md](m365-sync.md)) |
| Admin > Microsoft 365 sync: "Type unknown" for every mailbox | `MailboxSettings.Read` missing or not consented | Add it and grant admin consent |
| Admin > Shared mailbox access: `credentials_rejected` | Reader certificate expired or replaced | Upload a new certificate and update both Worker secrets |
| Admin > Copy back to Exchange: many `access_denied` | Mailbox outside the RBAC scope, or Exchange's cache (up to 2 hours) | Check group membership with `Test-ServicePrincipalAuthorization`; wait; **Retry failed** |
| Compose: no **Unblock and send again** on a blocked recipient | `CLOUDFLARE_SUPPRESSIONS_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` unset | Set both, redeploy Pages |

## Sources

- Cloudflare: [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/),
  [Create a token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/),
  [Account-owned tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
  [Workers authorization](https://developers.cloudflare.com/workers/authorization/),
  [Email Sending REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/) and
  [suppressions](https://developers.cloudflare.com/email-service/configuration/suppressions/#use-the-api) (Email Sending: Edit),
  [Email Routing DNS edit](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/edit/) (Zone Settings Write),
  [Email Routing catch-all](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/subresources/catch_alls/methods/get/) (Email Routing Rules Read),
  [Pages API](https://developers.cloudflare.com/pages/configuration/api/) (Cloudflare Pages: Edit),
  [Wrangler environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).
- Microsoft: [Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference),
  [App-only authentication for Exchange Online PowerShell](https://learn.microsoft.com/en-us/powershell/exchange/app-only-auth-powershell-v2),
  [RBAC for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac),
  [az ad app permission admin-consent](https://learn.microsoft.com/en-us/cli/azure/ad/app/permission#az-ad-app-permission-admin-consent).
- Each feature page cites the Microsoft pages behind its own permissions.

[← Documentation home](README.md)
