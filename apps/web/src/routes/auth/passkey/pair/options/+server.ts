// Phone side. With `wait: true` it only reports the offer's state (the phone
// polls this until the person approves it). Without, and only once approved, it
// returns the registration options.
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { bodyTooLarge, passkeyRouteContext } from '#lib/server/passkeys.js';
import { pairingRegistrationOptions, pairingWaitForPhone } from '#lib/server/passkey-pairing.js';

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
  const ip = (request.headers.get('cf-connecting-ip') || '').slice(0, 64);
  if ((body as { wait?: unknown } | null)?.wait === true) {
    const waiting = await pairingWaitForPhone(env, body, ip);
    if (!waiting.ok) return json({ message: waiting.message }, { status: waiting.status, headers: noStore });
    return json({ state: waiting.state, secondsLeft: waiting.secondsLeft }, { headers: noStore });
  }
  const result = await pairingRegistrationOptions(env, rp, body, ip);
  if (!result.ok) return json({ message: result.message }, { status: result.status, headers: noStore });
  return json({ challengeId: result.challengeId, options: result.options, deviceLabel: result.deviceLabel }, { headers: noStore });
};
