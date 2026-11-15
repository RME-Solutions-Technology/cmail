// Starts a passkey sign-in: a single-use server-side challenge for
// discoverable credentials. Reveals nothing about accounts.
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { passkeyRouteContext, startAuthentication } from '#lib/server/passkeys.js';

export const POST: RequestHandler = async ({ platform, url, request }) => {
  const env = platform?.env;
  const typedEnv = env as unknown as (Record<string, unknown> & { DB: D1Database }) | undefined;
  const rp = await passkeyRouteContext(typedEnv, url);
  if (!typedEnv || !rp) throw error(404, 'Not found');
  const result = await startAuthentication(typedEnv, rp, request);
  if (!result.ok) return json({ message: result.message }, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  return json({ challengeId: result.challengeId, options: result.options }, { headers: { 'Cache-Control': 'no-store' } });
};
