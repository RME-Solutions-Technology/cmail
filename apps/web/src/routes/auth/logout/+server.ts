import type { RequestHandler } from './$types';
import { clearSessionCookie } from '#lib/server/session.js';
import { audit } from '#lib/server/db.js';
import { clearProviderPreferenceCookie } from '#lib/server/provider-preference.js';
import { accessMode } from '#lib/server/access-jwt.js';

export const POST: RequestHandler = async ({ locals, platform, url }) => {
  const env = platform?.env;
  if (env && locals.user && locals.sessionId) {
    // Revoke session
    await env.DB.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').bind(locals.sessionId).run();
    await audit(env.DB, {
      event_type: 'auth.session_expired',
      actor_id: locals.user.id,
      actor_role: locals.user.role as 'standard' | 'manager',
      detail: 'User signed out',
      session_id: locals.sessionId,
    });
  }

  const headers = new Headers();
  headers.set('Set-Cookie', clearSessionCookie(url.protocol === 'https:'));
  headers.append('Set-Cookie', clearProviderPreferenceCookie());
  headers.set('Cache-Control', 'no-store');
  // Behind the Access bridge a still-valid Access session would sign the
  // user straight back in, so end that too. Cloudflare serves this path on
  // every Access-protected hostname.
  const accessOn = env ? accessMode(env as unknown as Record<string, unknown>).mode !== 'off' : false;
  headers.set('Location', accessOn ? '/cdn-cgi/access/logout' : '/');
  return new Response(null, { status: 303, headers });
};
