// Focused Inbox (docs/focused-inbox.md): move Inbox messages to Focused or
// Other, and optionally always move messages from their senders there
// (a per-mailbox entry, Outlook's "Always move to Other").
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isFocusClass } from '@cmail/shared/focused-inbox';
import { audit } from '#lib/server/db.js';
import { MAX_FOCUS_MOVE_IDS, moveMessagesFocus } from '#lib/server/focused-inbox.js';

const MAX_BODY_BYTES = 16_384;

export const POST: RequestHandler = async ({ locals, platform, request }) => {
  if (!locals.user) throw error(401, 'Authentication required');
  const env = platform?.env;
  if (!env) throw error(500, 'Service unavailable');

  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw error(415, 'JSON content type required');
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw error(413, 'Request too large');
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw error(413, 'Request too large');

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw error(400, 'Invalid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'Invalid request body');
  const { ids, to, always } = body as { ids?: unknown; to?: unknown; always?: unknown };

  if (!Array.isArray(ids) || ids.length === 0) throw error(400, 'Select at least one message');
  if (ids.length > MAX_FOCUS_MOVE_IDS) throw error(400, `A maximum of ${MAX_FOCUS_MOVE_IDS} messages can be moved at once`);
  if (ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128)) throw error(400, 'Invalid message identifiers');
  if (!isFocusClass(to)) throw error(400, 'Choose Focused or Other');
  if (always !== undefined && typeof always !== 'boolean') throw error(400, 'Invalid "always" value');

  const result = await moveMessagesFocus(env.DB, locals.user.id, ids as string[], to, always === true);
  if (!result.ok) throw error(result.status, result.message);

  // Counts only: no addresses or subjects in the audit log.
  await audit(env.DB, {
    event_type: 'focus.messages_moved',
    actor_id: locals.user.id,
    actor_role: locals.user.role,
    target: `messages:${ids.length}`,
    detail: `Moved ${result.moved} message${result.moved === 1 ? '' : 's'} to ${to === 'other' ? 'Other' : 'Focused'}${result.learned ? `; always move ${result.learned} sender${result.learned === 1 ? '' : 's'}` : ''}`,
    ip_address: request.headers.get('cf-connecting-ip') || null,
    session_id: locals.sessionId,
  });
  return json({ ok: true, moved: result.moved, learned: result.learned });
};
