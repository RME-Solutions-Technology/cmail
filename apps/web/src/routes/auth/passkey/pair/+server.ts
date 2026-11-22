// The phone side of "Add a phone": the page a scanned QR code opens. No
// sign-in needed. 404 unless a manager turned passkey sign-in on and the
// request is on APP_URL's origin. The pairing token is in the URL fragment,
// which this server never sees.
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { passkeyRouteContext } from '#lib/server/passkeys.js';
import { PASSKEY_PAGE_CSP } from '#lib/server/passkey-signin-page.js';
import { renderPasskeyPairPage } from '#lib/server/passkey-pair-page.js';
import { loadOrgSettings } from '#lib/server/org-settings.js';

export const GET: RequestHandler = async ({ platform, url }) => {
  const env = platform?.env;
  const rp = await passkeyRouteContext(env as unknown as (Record<string, unknown> & { DB: D1Database }) | undefined, url);
  if (!env || !rp) throw error(404, 'Not found');
  const settings = await loadOrgSettings(env as unknown as Record<string, unknown>);
  return new Response(renderPasskeyPairPage({ appName: settings.appName, orgName: settings.orgName }), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': PASSKEY_PAGE_CSP,
    },
  });
};
