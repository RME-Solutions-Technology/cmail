-- Microsoft 365 welcome emails: the sign-in name (docs/m365-welcome-emails.md).
-- The welcome email tells a person which account to use at Microsoft sign-in.
-- That is their userPrincipalName (UPN), which can differ from their primary
-- SMTP address (the Stanchion account address). The sync records the UPN on the
-- person's link each time it sees them. '' = not recorded yet (the email then
-- names the account address, as before).
--
-- Licence state needs no column: the sync only links a person while they are
-- enabled and hold a usable Exchange Online mailbox plan (assignedPlans), and
-- marks the link out of scope when they stop.
--
-- Upgrade note: additive only (one column with a default). Apply with
-- `pnpm db:migrate`. No existing row changes meaning.

ALTER TABLE m365_sync_links ADD COLUMN upn TEXT NOT NULL DEFAULT '' CHECK (length(upn) <= 254);
