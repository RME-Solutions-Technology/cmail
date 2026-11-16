import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { audit } from '#lib/server/db.js';
import {
  getOrganisationSignature,
  getPersonalSignature,
  sanitizeSignature,
  savePersonalSignature,
  type StoredPersonalSignature,
} from '#lib/server/signatures.js';
import { getComposeDefaults, parseComposeDefaultsForm, saveComposeDefaults } from '#lib/server/compose-preferences.js';
import { DEFAULT_COMPOSE_DEFAULTS } from '@cmail/shared/compose-style';
import { isFocusClass, normalizeFocusAddress, normalizeFocusDomain } from '@cmail/shared/focused-inbox';
import {
  canManageMailboxFocus,
  focusedInboxOrgEnabled,
  loadFocusSettings,
  removeFocusOverride,
  saveFocusOverride,
  scheduleFocusBackfills,
  setMailboxFocusEnabled,
} from '#lib/server/focused-inbox.js';

type FocusFormResult = { focusError?: string; focusSuccess?: string; focusMailbox?: string };

/**
 * Shared checks for the Focused Inbox actions: signed in, the organisation
 * switch on, and Full access to the named active mailbox.
 */
async function focusActionContext(
  request: Request,
  locals: App.Locals,
  platform: App.Platform | undefined,
): Promise<{ ok: true; env: App.Platform['env']; userId: string; role: 'standard' | 'manager'; mailboxId: string; form: FormData } | { ok: false; status: number; body: FocusFormResult }> {
  if (!locals.user) throw redirect(303, '/');
  const env = platform?.env;
  if (!env) return { ok: false, status: 503, body: { focusError: 'Service configuration is unavailable' } };
  const form = await request.formData();
  const mailboxId = form.get('mailbox_id');
  if (typeof mailboxId !== 'string' || !mailboxId || mailboxId.length > 64) {
    return { ok: false, status: 400, body: { focusError: 'Choose a mailbox' } };
  }
  if (!await focusedInboxOrgEnabled(env.DB)) {
    return { ok: false, status: 409, body: { focusError: 'Focused Inbox is turned off for the organisation', focusMailbox: mailboxId } };
  }
  if (!await canManageMailboxFocus(env.DB, locals.user.id, mailboxId)) {
    return { ok: false, status: 403, body: { focusError: 'Full access to this mailbox is needed to change it', focusMailbox: mailboxId } };
  }
  return { ok: true, env, userId: locals.user.id, role: locals.user.role, mailboxId, form };
}

function publicPersonalSignature(signature: StoredPersonalSignature | null) {
  if (!signature) return null;
  const content = sanitizeSignature(signature.html_body, signature.plain_text_body) || { html: '', plainText: '' };
  return {
    html: content.html,
    plainText: content.plainText,
    locked: signature.is_locked === 1,
    updatedAt: signature.updated_at,
  };
}

export const load: PageServerLoad = async ({ locals, platform }) => {
  if (!locals.user) throw redirect(303, '/');
  const env = platform?.env;
  if (!env) {
    return {
      personalSignature: null,
      organisationSignature: { html: '', plainText: '', enabled: false, locked: true },
      composeDefaults: { ...DEFAULT_COMPOSE_DEFAULTS },
      focusedInbox: null,
    };
  }

  const [personal, organisation, composeDefaults, focusOn] = await Promise.all([
    getPersonalSignature(env.DB, locals.user.id),
    getOrganisationSignature(env.DB),
    getComposeDefaults(env.DB, locals.user.id),
    focusedInboxOrgEnabled(env.DB),
  ]);
  // Focused Inbox (docs/focused-inbox.md): the section exists only while the
  // organisation switch is on. With it off this page is unchanged.
  // A failed read (for example, before migration 0031) hides the section.
  const focusedInbox = focusOn
    ? await loadFocusSettings(env.DB, locals.user.id).then((mailboxes) => ({ mailboxes }), () => null)
    : null;
  const organisationContent = organisation?.is_enabled === 1
    ? sanitizeSignature(organisation.html_body, organisation.plain_text_body) || { html: '', plainText: '' }
    : { html: '', plainText: '' };

  return {
    composeDefaults,
    personalSignature: publicPersonalSignature(personal),
    organisationSignature: {
      html: organisationContent.html,
      plainText: organisationContent.plainText,
      enabled: organisation?.is_enabled === 1,
      locked: organisation?.is_locked !== 0,
    },
    focusedInbox,
  };
};

export const actions: Actions = {
  focusToggle: async ({ request, locals, platform }) => {
    const context = await focusActionContext(request, locals, platform);
    if (!context.ok) return fail(context.status, context.body);
    const value = context.form.get('enabled');
    if (value !== 'true' && value !== 'false') return fail(400, { focusError: 'Invalid setting', focusMailbox: context.mailboxId });
    const enabled = value === 'true';
    await setMailboxFocusEnabled(context.env.DB, context.mailboxId, enabled, context.userId);
    await audit(context.env.DB, {
      event_type: 'focus.mailbox_toggled',
      actor_id: context.userId,
      actor_role: context.role,
      target: context.mailboxId,
      detail: `Focused Inbox turned ${enabled ? 'on' : 'off'} for a mailbox`,
    });
    // Sort recent mail in the background (bounded; only never-sorted mail).
    if (enabled) scheduleFocusBackfills(platform, [context.mailboxId]);
    return {
      focusMailbox: context.mailboxId,
      focusSuccess: enabled
        ? 'Focused and Other are on. Recent mail is being sorted now.'
        : 'Focused and Other are off. Your Inbox shows all mail in one list.',
    };
  },

  focusResort: async ({ request, locals, platform }) => {
    const context = await focusActionContext(request, locals, platform);
    if (!context.ok) return fail(context.status, context.body);
    await context.env.DB.prepare(
      `UPDATE focus_mailbox_settings SET backfill_status = 'none', updated_at = datetime('now')
       WHERE mailbox_id = ? AND enabled = 1
         AND (backfill_status = 'failed'
              OR (backfill_status = 'running' AND backfill_lease_until < CAST(strftime('%s', 'now') AS INTEGER) * 1000))`,
    ).bind(context.mailboxId).run();
    scheduleFocusBackfills(platform, [context.mailboxId]);
    return { focusMailbox: context.mailboxId, focusSuccess: 'Sorting recent mail again.' };
  },

  focusAddEntry: async ({ request, locals, platform }) => {
    const context = await focusActionContext(request, locals, platform);
    if (!context.ok) return fail(context.status, context.body);
    const raw = context.form.get('pattern');
    const focusClass = context.form.get('focus_class');
    if (!isFocusClass(focusClass)) return fail(400, { focusError: 'Choose Focused or Other', focusMailbox: context.mailboxId });
    const text = typeof raw === 'string' ? raw.trim() : '';
    // An entry with "@" in the middle is a sender address; otherwise a domain.
    const isAddress = text.lastIndexOf('@') > 0;
    const pattern = isAddress ? normalizeFocusAddress(text) : normalizeFocusDomain(text);
    if (!pattern) {
      return fail(400, { focusError: 'Enter a sender address (name@example.org) or a domain (example.org)', focusMailbox: context.mailboxId });
    }
    const kind = isAddress ? 'address' as const : 'domain' as const;
    const saved = await saveFocusOverride(context.env.DB, context.mailboxId, { kind, pattern, focusClass }, context.userId);
    if (saved === 'limit') {
      return fail(400, { focusError: 'This mailbox has reached its limit of 1,000 entries. Remove some first.', focusMailbox: context.mailboxId });
    }
    await audit(context.env.DB, {
      event_type: 'focus.override_saved',
      actor_id: context.userId,
      actor_role: context.role,
      target: context.mailboxId,
      detail: `Focused Inbox ${kind} entry set to ${focusClass === 'other' ? 'Other' : 'Focused'}`,
    });
    return {
      focusMailbox: context.mailboxId,
      focusSuccess: `New mail from ${pattern} will go to ${focusClass === 'other' ? 'Other' : 'Focused'}.`,
    };
  },

  focusRemoveEntry: async ({ request, locals, platform }) => {
    const context = await focusActionContext(request, locals, platform);
    if (!context.ok) return fail(context.status, context.body);
    const kind = context.form.get('kind');
    const pattern = context.form.get('pattern');
    if ((kind !== 'address' && kind !== 'domain') || typeof pattern !== 'string' || !pattern || pattern.length > 320) {
      return fail(400, { focusError: 'Invalid entry', focusMailbox: context.mailboxId });
    }
    const removed = await removeFocusOverride(context.env.DB, context.mailboxId, kind, pattern);
    if (removed) {
      await audit(context.env.DB, {
        event_type: 'focus.override_removed',
        actor_id: context.userId,
        actor_role: context.role,
        target: context.mailboxId,
        detail: `Focused Inbox ${kind} entry removed`,
      });
    }
    return { focusMailbox: context.mailboxId, focusSuccess: removed ? `Removed ${pattern}.` : 'That entry was already gone.' };
  },

  saveComposeDefaults: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(303, '/');
    const env = platform?.env;
    if (!env) return fail(503, { fontError: 'Service configuration is unavailable' });

    const parsed = parseComposeDefaultsForm(await request.formData());
    if (!parsed.ok) return fail(400, { fontError: parsed.error });
    try {
      await saveComposeDefaults(env.DB, locals.user.id, parsed.defaults);
    } catch {
      return fail(503, { fontError: 'Could not save the default font. Try again shortly.' });
    }
    await audit(env.DB, {
      event_type: 'compose_defaults.update',
      actor_id: locals.user.id,
      actor_role: locals.user.role,
      target: locals.user.id,
      detail: `Default font ${parsed.defaults.fontFamily} ${parsed.defaults.fontSizePt}pt`,
    });
    return { fontSuccess: 'Default font saved. New messages, replies and forwards will start in it.' };
  },
  savePersonal: async ({ request, locals, platform }) => {
    if (!locals.user) throw redirect(303, '/');
    const env = platform?.env;
    if (!env) return fail(503, { error: 'Service configuration is unavailable' });

    const existing = await getPersonalSignature(env.DB, locals.user.id);
    if (existing?.is_locked === 1) {
      return fail(403, { error: 'Your personal signature is managed by an administrator' });
    }

    const form = await request.formData();
    const html = form.get('html');
    const plainText = form.get('plain_text');
    if (typeof html !== 'string' || html.length > 65_536) {
      return fail(400, { error: 'Signature HTML must be 64 KB or fewer' });
    }
    if (plainText !== null && (typeof plainText !== 'string' || plainText.length > 16_384)) {
      return fail(400, { error: 'Plain-text signature must be 16,384 characters or fewer' });
    }

    const saved = await savePersonalSignature(env.DB, {
      userId: locals.user.id,
      html,
      plainText: typeof plainText === 'string' ? plainText : undefined,
      isLocked: false,
      updatedBy: locals.user.id,
      onlyIfUnlocked: true,
    });
    if (!saved) {
      const current = await getPersonalSignature(env.DB, locals.user.id);
      if (current?.is_locked === 1) {
        return fail(403, { error: 'Your personal signature is managed by an administrator' });
      }
      return fail(400, { error: 'The signature is too complex or couldn\'t be processed safely' });
    }

    await audit(env.DB, {
      event_type: 'signature.update',
      actor_id: locals.user.id,
      actor_role: locals.user.role,
      target: locals.user.id,
      detail: 'Updated personal signature',
    });
    return { success: 'Personal signature saved' };
  },
};
