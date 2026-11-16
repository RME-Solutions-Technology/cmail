---
title: "cmail documentation"
summary: "The index of every cmail guide, with where to start for primary mail or a Microsoft 365 standby."
applies_to: both
audience: [operator, manager, user]
switch: none
last_reviewed: 2026-11-16
related: [credentials.md, glossary.md, getting-started.md, onboarding-microsoft-365.md]
---

# cmail documentation

cmail is beta software (0.9, before 1.0). Operators should read the deployment and security
guides before sending real mail through it. Words like *switch*, *dry run*
and *standby* are defined in the [Glossary](glossary.md).

## Start here

- **Primary mail for a small organisation:** [Getting started](getting-started.md),
  then [Deployment and verification](deployment.md).
- **Standby for an organisation on Microsoft 365:** [Onboarding an
  organisation that uses Microsoft 365](onboarding-microsoft-365.md).
- **Either way:** [Credentials and permissions](credentials.md) lists every
  token, app and secret, with exact permissions.

## Use cmail

- [User guide](user-guide.md): first sign-in, reading, composing, folders, safety.
- [Calendar](calendar.md): meeting invitations.
- [Mobile app and notifications](mobile-pwa.md): install on a phone, new-mail alerts.
- [Shared mailboxes](shared-mailboxes.md): team addresses, Send as, Full access.
- [Email signatures](signatures.md): personal and organisation signatures.
- [Inbox rules](inbox-rules.md): file mail automatically.
- [Focused Inbox](focused-inbox.md): Focused and Other tabs (off by default), how mail is sorted and why.
- [Spam and quarantine](spam-and-quarantine.md): scoring, quarantine, sender rules.
- [AI agents and MCP](mcp.md): connect Claude or another AI app.
- [Mail client connectivity](mail-client-connectivity.md): why there is no IMAP yet, and the plan.

## Manage cmail

- [Manager handbook](manager-handbook.md): people, mailboxes, organisation, policy, mail trace, audit.
- [Travel approvals](travel-approvals.md): limit sign-in to approved countries.
- [Support process](support-process.md): triage, evidence, escalation.
- [Acceptable-use policy template](acceptable-use-policy-template.md).

## Deploy and run cmail

1. [Getting started](getting-started.md): local setup and Cloudflare storage.
2. [Configuration reference](configuration.md): every setting.
3. [Credentials and permissions](credentials.md): every token, app and secret.
4. [Email authentication](email-authentication.md): read before changing mail DNS.
5. [Architecture and trust boundaries](architecture.md).
6. [Deployment and verification](deployment.md): the production sequence.
7. [Security checklist](security-checklist.md) and [Operations checklist](operations-checklist.md).
8. [Running cmail](operations.md): upgrade, back up, restore, roll back, monitor, rotate secrets.
9. [Upgrading and keeping your settings](upgrading.md).

## Sign-in

- [Staff sign-in](staff-sign-in.md): staff-portal links, the Cloudflare Access bridge, Microsoft sign-in for synced people.
- [Passkey break-glass sign-in](passkeys.md): sign in when Microsoft or Access is down.

## Microsoft 365 standby

All off by default, each with its own Admin switch. Order and setup:
[Onboarding an organisation that uses Microsoft 365](onboarding-microsoft-365.md),
with scripts in [`scripts/onboarding/`](../scripts/onboarding/README.md).

- [Microsoft 365 sync](m365-sync.md): keep accounts and shared mailboxes in step with the tenant.
- [Microsoft 365 welcome emails](m365-welcome-emails.md): first sign-in steps for each new synced person.
- [Shared mailbox access from Exchange Online](m365-mailbox-permissions.md): copy Full Access and Send As daily.
- [Exchange mirror](exchange-mirror.md): a live copy of every mailbox from one journal rule.
- [Standby test address and daily probe](standby-probe.md): prove the standby path every day.
- [Standby switch](standby-switch.md): move incoming mail to cmail and back, one DNS change each.
- [Copy-back](copy-back.md): copy standby mail into Exchange after an outage.

## How cmail works

- [How cmail runs on Cloudflare](cloudflare-platform.md): the deployables, bindings, schedules and migrations.
- [How sending works](sending.md).
- [Delivery status and bounces](delivery-and-bounces.md).
- [How receiving works](receiving.md).
- [Reading mail safely](reading-mail-safely.md).
- [Inbox rules: how the engine works](inbox-rules.md#how-the-rules-engine-works-developers).
- [Push notification reliability](push-notification-reliability.md): a design, not built.

## Governance

- [Security, privacy, and assurance](assurance.md).
- [ISO and ITIL alignment](standards-alignment.md).
- [Privacy and data handling](privacy-and-data-handling.md).
- [Branding](branding.md).
- [Downstream and private implementations](downstream-implementations.md).
- [Project roadmap](../ROADMAP.md).

## Contributors and maintainers

- [Developer guide](development.md).
- [Maintainer release guide](maintainer-guide.md).
- Reviews: [security review, September 2026](security-review-2026-09-13.md), [dependency review, 22 September 2026](dependency-review-2026-09-22.md), [dependency review, 9 September 2026](dependency-review-2026-09-09.md).
- [Contributing](../CONTRIBUTING.md), [Support](../SUPPORT.md), [Security policy](../SECURITY.md), [Code of Conduct](../CODE_OF_CONDUCT.md).

## Command reference

Run from the repository root:

| Command | Use |
|---|---|
| `pnpm run setup` | Create ignored local configuration from committed templates |
| `pnpm dev` | Start the SvelteKit development server |
| `pnpm dev:worker` | Start the email Worker with `wrangler dev` |
| `pnpm db:migrate:verify` | Apply every migration to a throwaway local D1 and check the schema |
| `pnpm test:mobile` | Run the Playwright mobile and accessibility suite (see the [Developer guide](development.md#2-run-the-tests)) |
| `pnpm db:migrate:local` | Apply migrations to isolated local D1 state |
| `pnpm db:migrate:preview` | Apply migrations to the explicitly isolated preview D1 database |
| `pnpm config:check` | Verify committed and active Wrangler bindings remain isolated and fail closed |
| `pnpm deploy:email-worker:preview` | Deploy the isolated, non-sending preview email Worker |
| `pnpm push:keys` | Generate a VAPID pair for optional browser notifications |
| `pnpm validate` | Run source, lint, type, test, migration, build, and dependency checks |
| `pnpm release:check` | Run validation plus the reachable Git-history secret gate |

## Page metadata

Each page starts with a metadata block between `---` lines: `title`,
`summary`, `applies_to` (`primary`, `standby` or `both`), `audience` (any of `operator`, `manager`, `user`),
`switch` (the Admin label that turns the feature on, or `none`),
`last_reviewed` and `related` (file names). The docs site reads it for
search; GitHub shows it as a table.
