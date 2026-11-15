// Finishes a passkey sign-in and sets the session cookie. Every refusal gets
// the same message; the audit log records the reason.
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertStrongSessionSecret } from '#lib/server/config.js';
import { NEUTRAL_SIGNIN_FAILURE, finishAuthentication, passkeyRouteContext } from '#lib/server/passkeys.js';

const MAX_BODY_BYTES = 32 * 1024;

export const POST: RequestHandler = async ({ platform, url, request }) => {
  const env = platform?.env;
  const typedEnv = env as unknown as (Record<string, unknown> & { DB: D1Database; SESSION_SECRET: string }) | undefined;
  const rp = await passkeyRouteContext(typedEnv, url);
  if (!typedEnv || !rp) throw error(404, 'Not found');
  const noStore = { 'Cache-Control': 'no-store' };
  try {
    assertStrongSessionSecret(typedEnv.SESSION_SECRET);
  } catch {
    return json({ message: NEUTRAL_SIGNIN_FAILURE }, { status: 503, headers: noStore });
  }

  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > MAX_BODY_BYTES) return json({ message: NEUTRAL_SIGNIN_FAILURE }, { status: 413, headers: noStore });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ message: NEUTRAL_SIGNIN_FAILURE }, { status: 413, headers: noStore });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ message: NEUTRAL_SIGNIN_FAILURE }, { status: 400, headers: noStore });
  }

  const result = await finishAuthentication(typedEnv, rp, request, body, {
    secureCookie: url.protocol === 'https:',
    waitUntil: platform?.context?.waitUntil ? (promise) => platform.context.waitUntil(promise) : undefined,
  });
  if (!result.ok) return json({ message: result.message }, { status: result.status, headers: noStore });
  const headers = new Headers(noStore);
  headers.append('Set-Cookie', result.cookie);
  return json({ location: result.location }, { headers });
};
