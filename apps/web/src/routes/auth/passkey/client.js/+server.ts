import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { passkeyRouteContext } from '#lib/server/passkeys.js';
import { PASSKEY_CLIENT_JS, PASSKEY_PAGE_CSP } from '#lib/server/passkey-signin-page.js';

export const GET: RequestHandler = async ({ platform, url }) => {
  const env = platform?.env;
  const rp = await passkeyRouteContext(env as unknown as (Record<string, unknown> & { DB: D1Database }) | undefined, url);
  if (!rp) throw error(404, 'Not found');
  return new Response(PASSKEY_CLIENT_JS, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': PASSKEY_PAGE_CSP,
    },
  });
};
