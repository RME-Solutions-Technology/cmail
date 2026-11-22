// Phone side: stores the new passkey for the account that made the offer, once
// the person has approved this phone.
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { bodyTooLarge, passkeyRouteContext } from '#lib/server/passkeys.js';
import { finishPairing } from '#lib/server/passkey-pairing.js';

const MAX_BODY_BYTES = 32 * 1024;

export const POST: RequestHandler = async ({ platform, url, request }) => {
  const env = platform?.env as unknown as (Record<string, unknown> & { DB: D1Database }) | undefined;
  const rp = await passkeyRouteContext(env, url);
  if (!env || !rp) throw error(404, 'Not found');
  const noStore = { 'Cache-Control': 'no-store' };
  const raw = await request.text();
  if (bodyTooLarge(raw, MAX_BODY_BYTES)) return json({ message: 'Request too large' }, { status: 413, headers: noStore });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ message: 'Invalid request' }, { status: 400, headers: noStore });
  }
  const result = await finishPairing(env, rp, body, {
    clientIp: (request.headers.get('cf-connecting-ip') || '').slice(0, 64),
    waitUntil: platform?.context?.waitUntil ? (promise) => platform.context.waitUntil(promise) : undefined,
  });
  if (!result.ok) return json({ message: result.message }, { status: result.status, headers: noStore });
  return json({ passkey: result.passkey }, { headers: noStore });
};
