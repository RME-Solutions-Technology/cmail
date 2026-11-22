// The phone presents the pairing token (from the QR code) and joins the offer.
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { bodyTooLarge, passkeyRouteContext } from '#lib/server/passkeys.js';
import { joinPairing } from '#lib/server/passkey-pairing.js';

const MAX_BODY_BYTES = 4 * 1024;

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
  const result = await joinPairing(env, request, body, (request.headers.get('cf-connecting-ip') || '').slice(0, 64));
  if (!result.ok) return json({ message: result.message }, { status: result.status, headers: noStore });
  return json({ joiner: result.joiner, deviceLabel: result.deviceLabel, secondsLeft: result.secondsLeft }, { headers: noStore });
};
