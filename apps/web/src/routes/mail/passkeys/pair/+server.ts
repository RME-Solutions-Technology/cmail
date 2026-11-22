// Signed-in side of "Add a phone": GET reports the offer's state; POST
// {action: 'create' | 'approve' | 'deny'}. Ordinary sessions only; the
// creating session alone can approve or deny (passkey-pairing.ts).
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { bodyTooLarge, passkeyRouteContext } from '#lib/server/passkeys.js';
import { approvePairing, createPairing, denyPairing, pairingStatus } from '#lib/server/passkey-pairing.js';

const MAX_BODY_BYTES = 2 * 1024;
const noStore = { 'Cache-Control': 'private, no-store' };

type PairEnv = Record<string, unknown> & { DB: D1Database };

export const GET: RequestHandler = async ({ platform, url, locals, request }) => {
  const env = platform?.env as unknown as PairEnv | undefined;
  const rp = await passkeyRouteContext(env, url);
  if (!env || !rp) throw error(404, 'Not found');
  if (!locals.user) return json({ error: 'Authentication required' }, { status: 401, headers: noStore });
  const result = await pairingStatus(env, locals.user, locals.sessionId, { clientIp: (request.headers.get('cf-connecting-ip') || '').slice(0, 64) });
  if (!result.ok) return json({ error: result.error }, { status: result.status, headers: noStore });
  return json(result.status, { headers: noStore });
};

export const POST: RequestHandler = async ({ platform, url, locals, request }) => {
  const env = platform?.env as unknown as PairEnv | undefined;
  const rp = await passkeyRouteContext(env, url);
  if (!env || !rp) throw error(404, 'Not found');
  if (!locals.user) return json({ error: 'Authentication required' }, { status: 401, headers: noStore });
  const raw = await request.text();
  if (bodyTooLarge(raw, MAX_BODY_BYTES)) return json({ error: 'Request too large' }, { status: 413, headers: noStore });
  let body: { action?: unknown; pairingId?: unknown; code?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json({ error: 'Invalid request' }, { status: 400, headers: noStore });
  }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, { status: 400, headers: noStore });
  const clientIp = (request.headers.get('cf-connecting-ip') || '').slice(0, 64);
  if (body.action === 'create') {
    const result = await createPairing(env, locals.user, locals.sessionId, { clientIp });
    if (!result.ok) return json({ error: result.error }, { status: result.status, headers: noStore });
    return json({
      pairingId: result.pairingId,
      // The token is shown once, in the fragment, so it never reaches a server log.
      pairUrl: `${rp.origin}/auth/passkey/pair#${result.token}`,
      secondsLeft: result.secondsLeft,
    }, { headers: noStore });
  }
  if (body.action === 'approve' || body.action === 'deny') {
    const result = body.action === 'approve'
      ? await approvePairing(env, locals.user, locals.sessionId, body.pairingId, body.code, { clientIp })
      : await denyPairing(env, locals.user, locals.sessionId, body.pairingId, { clientIp });
    if (!result.ok) return json({ error: result.error }, { status: result.status, headers: noStore });
    return json({ ok: true }, { headers: noStore });
  }
  return json({ error: 'Invalid request' }, { status: 400, headers: noStore });
};
