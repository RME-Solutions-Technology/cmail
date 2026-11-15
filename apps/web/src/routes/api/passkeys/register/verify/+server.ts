// Verifies and stores a new passkey for the signed-in person.
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { finishRegistration, passkeyRouteContext } from '#lib/server/passkeys.js';

const MAX_BODY_BYTES = 32 * 1024;

export const POST: RequestHandler = async ({ platform, url, locals, request }) => {
  if (!locals.user) return json({ error: 'Authentication required' }, { status: 401 });
  const typedEnv = platform?.env as unknown as (Record<string, unknown> & { DB: D1Database }) | undefined;
  const rp = await passkeyRouteContext(typedEnv, url);
  if (!typedEnv || !rp) throw error(404, 'Not found');
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'Request too large' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid request' }, { status: 400 });
  }
  const result = await finishRegistration(typedEnv, rp, locals.user, locals.sessionId, body, {
    clientIp: (request.headers.get('cf-connecting-ip') || '').slice(0, 64),
    waitUntil: platform?.context?.waitUntil ? (promise) => platform.context.waitUntil(promise) : undefined,
  });
  if (!result.ok) return json({ error: result.error }, { status: result.status });
  return json({ passkey: result.passkey });
};
