---
title: "Maintainer release guide"
summary: "How maintainers cut and publish a Stanchion release."
applies_to: both
audience: [developer]
switch: none
last_reviewed: 2026-11-16
related: [development.md]
---

# Maintainer release guide

This guide covers public-repository and release hygiene. It does not replace
the deployment or operations checklists used by each Stanchion operator.

## Repository settings

After creating or transferring the public GitHub repository:

- set `main` as the default branch;
- set a concise repository description and add discoverability topics such as
  `email`, `self-hosted`, `cloudflare`, `sveltekit`, `oauth`, and
  `email-routing`;
- upload a PNG, JPG, or GIF social preview derived from
  `apps/web/static/og-image.svg` under **Settings → Social preview**;
- enable private vulnerability reporting and review the contact path in
  [SECURITY.md](../SECURITY.md);
- enable dependency graph, Dependabot alerts, secret scanning, and push
  protection where available;
- protect `main` with pull requests, successful CI checks, resolved review
  conversations, and protection from force pushes and deletion;
- grant write, administration, Pages, DNS, and provider access only to people
  who need it;
- create the labels referenced by issue forms and `.github/release.yml`, or
  adjust that metadata to the repository's chosen labels.

Repository security features complement the local release gates; they do not
make committed credentials safe. Revoke any exposed value before addressing
its Git history.

GitHub's current social-preview requirements are documented in
[Customizing your repository's social media preview](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

## Prepare a release

1. Work from an up-to-date, reviewed branch with no unrelated changes.
2. Review `git diff`, dependency changes, documentation, and the full commit
   list. Run `pnpm db:migrate:verify` to apply and inspect migrations in a
   throwaway local D1 (Cloudflare's database, emulated by Wrangler on this
   machine; nothing remote is touched).
3. Update [CHANGELOG.md](../CHANGELOG.md) with user-visible, operational,
   migration, security, and compatibility notes. Rename `[Unreleased]` to
   `[X.Y.Z] - YYYY-MM-DD` and leave a new empty `[Unreleased]` above it.
   Set the same `version` in the root `package.json`, `apps/web`,
   `apps/email-worker`, `apps/backup-worker` and `packages/shared`, and set
   `version` and `date-released` in `CITATION.cff`. `.zenodo.json` carries no
   version, so only check that its description is still accurate.
4. Run `pnpm release:check`. A source or reachable-history secret finding is a
   release blocker.
5. Complete affected manual scenarios from
   [deployment verification](deployment.md#verification) in an isolated staging
   environment.
6. Confirm rollback, backup, restore, and credential-rotation owners.
7. Create the version tag (`vX.Y.Z`) only after the
   release commit is approved, then push it.

CI runs `pnpm release:check` on Node 22, 24 and 26 for every pull request, so
a green run on the release commit is the same gate you ran locally.

For identity changes, inspect the complete authorization-code and enrolment
flow, not just the sign-in button. Confirm both providers obtain identity from
access-token UserInfo, returning accounts resolve solely by provider plus
`sub`, invitation hashes remain single-use and expiring, resend revokes older
links, and raw invitation/bootstrap credentials never enter provider callbacks
or logs. A release must not reintroduce Microsoft `/me`, email/UPN lookup, or
ID-token claims as an account selector. A release touching email one-time-code
sign-in must keep codes hashed and single-use, keep the Manager role refusing
an email-only identity, and keep Turnstile scoped to the request form only. A
release touching sign-in countries must keep the first-manager bootstrap
exemption and the manager-notification throttle intact.

## Release notes

GitHub's generated release notes use `.github/release.yml` for categories.
Review generated notes rather than publishing them verbatim. Call out:

- required configuration or secret changes;
- D1 migrations and upgrade order;
- changes to OAuth callbacks, UserInfo endpoints, identity audiences, scopes,
  immutable subject binding, enrolment, bootstrap, or sessions;
- data exposure, retention, mail-flow, or DNS implications;
- known limitations and staging evidence.

Do not include private issue details, deployment identifiers, production URLs,
message content, personal data, or secret values in commits, tags, artifacts,
screenshots, or release notes.

## Legacy names kept on purpose

The product was renamed from cMail to Stanchion. Names that deployed systems,
saved data or secrets already depend on still say `cmail`. Renaming them would
sign people out, orphan stored data or mean new Cloudflare resources, so they
are legacy names, kept on purpose:

- cookies and browser storage keys: `cmail_session`, `cmail_enrollment`,
  `cmail_oauth_*`, `cmail_bootstrap_proof`, `cmail_otp_proof`,
  `__Host-cmail_last_provider`, `cmail_push_*`, `cmail_pwa_dismissed`;
- saved-HTML markers: `data-cmail-signature`, `data-cmail-link-risk`,
  `data-cmail-link-host`;
- environment variables and build constants: `CMAIL_*`, `__CMAIL_BUILD__`;
- Cloudflare resource names and service hosts in `wrangler.toml.example`:
  `cmail-web`, `cmail-db`, `cmail-storage`, `cmail-backup`,
  `cmail-email-worker`, `cmail-email-worker.internal`, `cmail-email-events`,
  `cmail-exo-permissions`, `cmail-standby-probe` and the rate-limit namespaces;
- identity names that tenants already hold: the `cmail mirror` journal rule,
  `cmail Mailbox Access Readers` role group, `cmail Exchange permission reader`
  app, the `cmail standby copy` Outlook category, the `cmail standby test`
  probe subject, the `cmail standby` remote domain, the `cmail journal` remote
  domain, the `cmail Microsoft 365 sync` and `cmail directory sync` apps, the
  `cmail standby copy-back` app and the `cmail copy-back mailboxes` and
  `cmail mirror mailboxes` groups and management scopes (docs and scripts quote
  these exactly, so copied commands match what customers already have);
- the `@cmail/*` package scope, type and CSS variable names, and the GitHub
  repository URL, until each is renamed in its own change.

New text should say Stanchion. Keep a legacy name exactly as it is when you
quote it.

[← Documentation home](README.md)
