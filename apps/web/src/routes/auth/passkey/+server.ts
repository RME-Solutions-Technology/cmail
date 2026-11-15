// Passkey break-glass sign-in page (docs/passkeys.md). 404 unless a manager
// turned passkey sign-in on and the request is on APP_URL's origin.
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { passkeyRouteContext } from '#lib/server/passkeys.js';
import { PASSKEY_PAGE_CSP, renderPasskeySignInPage } from '#lib/server/passkey-signin-page.js';
import { loadOrgSettings } from '#lib/server/org-settings.js';

export const GET: RequestHandler = async ({ platform, url, locals }) => {
  const env = platform?.env;
  const rp = await passkeyRouteContext(env as unknown as (Record<string, unknown> & { DB: D1Database }) | undefined, url);
  if (!env || !rp) throw error(404, 'Not found');
  if (locals.user) {
    return new Response(null, { status: 303, headers: { Location: '/mail', 'Cache-Control': 'no-store' } });
  }
  const settings = await loadOrgSettings(env as unknown as Record<string, unknown>);
  return new Response(renderPasskeySignInPage({ appName: settings.appName, orgName: settings.orgName }), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': PASSKEY_PAGE_CSP,
    },
  });
};
