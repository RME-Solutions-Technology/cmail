// Registration options for a new passkey. Signed-in people only, from an
// ordinary (non-passkey) session opened in the last few minutes.
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { passkeyRouteContext, startRegistration } from '#lib/server/passkeys.js';

export const POST: RequestHandler = async ({ platform, url, locals }) => {
  // 404 first: while the switch is off the endpoint does not exist for anyone.
  const typedEnv = platform?.env as unknown as (Record<string, unknown> & { DB: D1Database }) | undefined;
  const rp = await passkeyRouteContext(typedEnv, url);
  if (!typedEnv || !rp) throw error(404, 'Not found');
  if (!locals.user) return json({ error: 'Authentication required' }, { status: 401 });
  const result = await startRegistration(typedEnv, rp, locals.user, locals.sessionId);
  if (!result.ok) return json({ error: result.error }, { status: result.status });
  return json({ challengeId: result.challengeId, options: result.options });
};
