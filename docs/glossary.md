---
title: "Glossary"
summary: "The terms cmail's documentation uses, each with one meaning, and the page that covers it."
applies_to: both
audience: [operator, manager, user]
switch: none
last_reviewed: 2026-11-16
related: [README.md, credentials.md]
---

# Glossary

One meaning per term. The docs use these words exactly this way.

## cmail and its people

| Term | Meaning |
|---|---|
| **Instance** | One cmail deployment: its own Cloudflare account resources (D1, R2, email Worker, Pages project) for one organisation. |
| **Operator** | Whoever runs an instance: deploys it, holds its Cloudflare access and secrets. See [Credentials and permissions](credentials.md). |
| **Manager** | The cmail role that administers people, mailboxes and settings in **Admin**. See the [Manager handbook](manager-handbook.md). |
| **Client admin** | The organisation's Microsoft 365 administrator, who creates or consents to the Entra apps. |
| **Bootstrap** | The one-time step that creates the first manager with a temporary token. See [Deployment](deployment.md#9-bootstrap-and-lock-down-administration). |
| **Primary mail** | cmail is the organisation's mail system: the domain's MX points to Cloudflare Email Routing. |
| **Shared mailbox** | A team address several people use, with Read, Send as or Full access. See [Shared mailboxes](shared-mailboxes.md). |

## Switches and safety

| Term | Meaning |
|---|---|
| **Switch** | An on/off setting a manager changes in Admin (for example **Admin > Microsoft 365 > Directory sync**). Every optional feature ships with its switch off. |
| **Dry run** | A mode that reads everything and reports what it *would* change, but changes nothing. Features that change accounts or mail start in dry run. |
| **Brake** | A limit that holds a large change (for example many pauses or removals at once) until a manager approves it in Admin. |
| **Fail closed** | When a check cannot be completed, cmail refuses rather than allows. |
| **Break-glass** | A way in that works when the normal one is down: [passkey sign-in](passkeys.md) when Microsoft or Cloudflare Access is unavailable. |

## Microsoft 365 standby

| Term | Meaning |
|---|---|
| **Standby** | cmail kept ready to take an organisation's mail if Exchange Online fails, while Exchange stays primary. |
| **Warm standby** | A standby that already holds recent mail, kept current by the Exchange mirror. |
| **Tenant** | One Microsoft 365 organisation, identified by its tenant ID (a GUID). |
| **Sync** | [Microsoft 365 sync](m365-sync.md): reads people and shared mailboxes from the tenant and keeps cmail accounts in step. Read only toward Microsoft. |
| **Sync round** | One sync run: a delta run (changes only) or a full reconciliation. |
| **Standby subdomain** | A subdomain (for example `standby.example.com`) whose MX points to Cloudflare, so cmail can receive mail while the main domain stays on Exchange. |
| **Probe** | The daily test message sent to each [standby test address](standby-probe.md) to prove the standby path works. Shown in **Admin > Standby test** as green, amber or red. |
| **Switch over / switch back** | Moving the domain's MX to Cloudflare (cmail takes the mail) and back to Exchange, one DNS change each. See [Standby switch](standby-switch.md). |
| **Copy-back** | After an outage, copying the mail cmail received into each person's Exchange mailbox. See [Copy-back](copy-back.md). |
| **Mirror** | The [Exchange mirror](exchange-mirror.md): cmail files a copy of every message Exchange delivers, from journal reports. |
| **Journal rule** | An Exchange Online rule that sends a journal report for each message to one address. |
| **Journal report** | The message Exchange sends for each journaled message: an envelope listing the recipients, with the original message attached. |
| **Journal address** | The secret address journal reports go to. Knowing it is what lets a report in, so it is stored as a Worker secret. |
| **NDR** | Non-delivery report: a bounce. For journaling, the "undeliverable journal reports" address receives reports that could not be delivered. |
| **Full Access / Send As** | Exchange shared mailbox permissions. [Shared mailbox access](m365-mailbox-permissions.md) copies them into cmail. |

## Cloudflare

| Term | Meaning |
|---|---|
| **Email Routing** | Cloudflare's inbound mail: rules route each address to the email Worker. |
| **Email Sending** | Cloudflare's outbound mail service (Email Service). cmail sends through the email Worker's `send_email` binding. |
| **Suppression list** | Addresses Cloudflare will not send to after a hard bounce or complaint. The sender can lift a bounce block with **Unblock and send again**. See [Delivery and bounces](delivery-and-bounces.md). |
| **Worker** | The email Worker (`apps/email-worker`): receives mail, sends mail and runs scheduled jobs. |
| **Pages** | The web app (`apps/web`) on Cloudflare Pages. |
| **D1 / R2** | Cloudflare's database (accounts, settings, message index) and object storage (message bodies and attachments). |
| **Container** | A Cloudflare Container that runs the Exchange Online PowerShell reader for shared mailbox access. Needs Workers Paid. |
| **Access bridge** | Sign-in from a Cloudflare Access token, so a site behind Access has no second sign-in. See [Staff sign-in](staff-sign-in.md). |
| **Account-owned token** | A Cloudflare API token owned by the account, not a person. Preferred for every token in [Credentials](credentials.md). |

## Microsoft Entra

| Term | Meaning |
|---|---|
| **App registration** | An Entra app. cmail uses a separate one per job. See [Credentials](credentials.md#microsoft-entra-apps). |
| **Delegated permission** | Acts as the signed-in person (the sign-in app). |
| **Application permission** | Acts as the app itself with no person signed in (the sync app). |
| **Admin consent** | A tenant admin's approval of an app's permissions for the whole tenant. Application permissions always need it. |
| **RBAC for Applications** | Exchange Online's way to give an app a mail role on a scoped set of mailboxes only. Used by copy-back. |
| **PIM** | Privileged Identity Management: admin roles that must be activated before use. |

## Mail terms

| Term | Meaning |
|---|---|
| **MX** | The DNS record that says which server receives a domain's mail. |
| **SPF, DKIM, DMARC** | Sender checks. See [Email authentication](email-authentication.md). |
| **MCP** | Model Context Protocol: how AI apps connect to cmail. See [AI agents and MCP](mcp.md). |

[← Documentation home](README.md)
