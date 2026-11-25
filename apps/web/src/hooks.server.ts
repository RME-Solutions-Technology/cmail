import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import type { User } from '@stanchion/shared/types';
import { assertStrongSessionSecret, publicRuntimeConfig, sessionTtlMs } from '#lib/server/config.js';
import { SESSION_COOKIE, clearSessionCookie, getSessionTokenFromCookie, hashToken, shouldRenewSession, verifySessionToken } from '#lib/server/session.js';
import { mcpMaintenanceStatements } from '#lib/server/mcp/maintenance.js';
import { runtimePlatform } from '#lib/server/cloudflare-runtime.js';
import { ACCESS_JWT_HEADER, accessMode, verifyAccessJwt, type AccessIdentity } from '#lib/server/access-jwt.js';
import { accessSignInPathAllowed, confirmSessionAccessBinding, establishAccessSession } from '#lib/server/access-bridge.js';
import { passkeySessionState, relyingParty } from '#lib/server/passkeys.js';

let loggedAccessMisconfiguration = false;

function setsSessionCookie(response: Response): boolean {
  return response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`) && !/;\s*Max-Age=0/i.test(cookie));
}

function appendVary(headers: Headers, value: string): void {
  const values = new Set(
    (headers.get('Vary') || '').split(',').map((item) => item.trim()).filter(Boolean),
  );
  values.add(value);
  headers.set('Vary', [...values].join(', '));
}

function secureResponse(response: Response, authenticated: boolean, isHttps: boolean): Response {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  response.headers.set('X-Permitted-Cross-Domain-Policies', 'none');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  if (isHttps) response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (authenticated) {
    response.headers.set('Cache-Control', 'private, no-store');
    appendVary(response.headers, 'Cookie');
  }
  return response;
}

function isUnsafeCrossOrigin(request: Request, requestOrigin: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return false;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return true;
  const origin = request.headers.get('origin');
  return !!origin && origin !== requestOrigin;
}

// SvelteKit's built-in CSRF guard (kit.csrf) is replaced by this identical
// check so that exactly two machine-facing OAuth endpoints can accept the
// form-encoded POSTs that native MCP clients send without an Origin header
// (RFC 6749 requires that encoding at the token endpoint). Those endpoints
// never read cookies: they authenticate the client with PKCE or a client
// secret, so a cross-site form post to them gains an attacker nothing.
// Every other path keeps SvelteKit's exact rule: a form-encoded POST, PUT,
// PATCH or DELETE must carry an Origin equal to this origin.
const FORM_CONTENT_TYPES = new Set([
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
  'application/x-sveltekit-formdata',
]);
const CSRF_EXEMPT_MACHINE_PATHS = new Set(['/oauth/token', '/oauth/revoke']);

export function isCrossSiteFormSubmission(request: Request, url: URL): boolean {
  if (CSRF_EXEMPT_MACHINE_PATHS.has(url.pathname)) return false;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) return false;
  const contentType = (request.headers.get('content-type')?.split(';', 1)[0].trim() ?? '').toLowerCase();
  if (!FORM_CONTENT_TYPES.has(contentType)) return false;
  return request.headers.get('origin') !== url.origin;
}

function isAdminRequestPath(pathname: string): boolean {
  // SvelteKit form-action query strings are excluded from pathname, while
  // internal page-data requests remain below the /admin segment (for example,
  // /admin/users/__data.json). Match a complete path segment so an unrelated
  // route such as /administrator is not treated as an admin route.
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = null;
  event.locals.sessionId = null;
  event.locals.passkeySession = false;
  if (!event.platform) {
    // adapter-cloudflare 8 no longer provides event.platform; RequestEvent types it read-only.
    Object.defineProperty(event, 'platform', { value: runtimePlatform(), writable: true, configurable: true, enumerable: true });
  }

  const env = event.platform?.env;
  const isHttps = event.url.protocol === 'https:';

  if (isUnsafeCrossOrigin(event.request, event.url.origin)) {
    return secureResponse(new Response('Cross-origin request blocked', { status: 403 }), false, isHttps);
  }
  if (isCrossSiteFormSubmission(event.request, event.url)) {
    const message = `Cross-site ${event.request.method.toUpperCase()} form submissions are forbidden`;
    const denied = event.request.headers.get('accept') === 'application/json'
      ? Response.json({ message }, { status: 403 })
      : new Response(message, { status: 403 });
    return secureResponse(denied, false, isHttps);
  }

  // Cloudflare Access bridge. Off when ACCESS_TEAM_DOMAIN and ACCESS_AUD are
  // both unset. Otherwise every session, cookie-based or new, needs a valid
  // Access token on this request, and a broken configuration fails closed.
  // The one exception is a passkey session (see below).
  const access = env ? accessMode(env as unknown as Record<string, unknown>) : { mode: 'off' as const };
  let accessIdentity: AccessIdentity | null = null;
  if (access.mode === 'misconfigured') {
    if (!loggedAccessMisconfiguration) {
      loggedAccessMisconfiguration = true;
      console.error('Access bridge misconfigured; all requests are signed out', { reason: access.reason });
    }
  } else if (access.mode === 'on') {
    try {
      accessIdentity = await verifyAccessJwt(event.request.headers.get(ACCESS_JWT_HEADER), access.config);
    } catch {
      accessIdentity = null;
    }
  }
  const accessGatePassed = access.mode === 'off' || accessIdentity !== null;

  let clearInvalidCookie = false;
  let accessSessionCookie: string | null = null;
  // A passkey session (sessions.passkey_credential_id set) was opened without
  // Microsoft or Access, so it does not need an Access token: it is the one
  // kind of cookie session the Access gate lets through (docs/passkeys.md).
  // Every other cookie session still needs a valid Access token whenever the
  // bridge is on or misconfigured, exactly as before.
  let keepCookie = !accessGatePassed;
  let setAsidePasskeySessionId: string | null = null;
  const token = getSessionTokenFromCookie(event.request.headers.get('cookie'));
  if (env && token) {
    try {
      assertStrongSessionSecret(env.SESSION_SECRET);
      const verified = await verifySessionToken(token, env.SESSION_SECRET);
      if (verified) {
        const tokenHash = await hashToken(token);
        // SELECT * so a database without migration 0025 (no marker column)
        // still reads every session as an ordinary one.
        const session = await env.DB.prepare(
          `SELECT * FROM sessions
           WHERE token_hash = ? AND revoked = 0 AND expires_at > datetime('now')`,
        ).bind(tokenHash).first<{ id: string; user_id: string; expires_at: string; passkey_credential_id?: string | null }>();
        const passkeyCredentialId = typeof session?.passkey_credential_id === 'string' && session.passkey_credential_id
          ? session.passkey_credential_id
          : null;

        if (
          session && session.id === verified.sessionId && session.user_id === verified.userId
          && (accessGatePassed || passkeyCredentialId)
        ) {
          let user = await env.DB.prepare(
            `SELECT * FROM users WHERE id = ? AND status IN ('active', 'pending')`,
          ).bind(verified.userId).first<User>();
          if (user && passkeyCredentialId && user.status !== 'active') {
            // Passkey sessions are for active accounts only (not pending).
            user = null;
          } else if (user && passkeyCredentialId && event.url.origin !== relyingParty(env as unknown as Record<string, unknown>)?.origin) {
            // Passkey sessions are bound to the relying party's origin
            // (APP_URL): a replayed cookie on *.pages.dev or another
            // hostname gets nothing. The session itself is left alone.
            user = null;
          } else if (user && passkeyCredentialId) {
            // Live only while the feature is on and the passkey still exists.
            const state = await passkeySessionState(env.DB, passkeyCredentialId, user.id);
            if (state === 'dead') {
              await env.DB.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').bind(session.id).run();
              keepCookie = false;
            } else if (state === 'error') {
              // The check failed, not the session: signed out for this
              // request only, cookie kept.
              keepCookie = true;
            }
            if (state !== 'live') user = null;
          }
          // Under Access, the session must belong to the person Access
          // admitted. An ordinary session for someone else is revoked, not
          // reused. A passkey session for someone else is only set aside for
          // this request (never revoked, cookie kept): Access then signs the
          // token's person in as usual.
          const sessionMatchesAccess = !user || !accessIdentity
            || await confirmSessionAccessBinding(
              env.DB,
              user,
              accessIdentity,
              (event.request.headers.get('cf-connecting-ip') || '').slice(0, 64),
            );
          if (user && !sessionMatchesAccess) {
            if (passkeyCredentialId) {
              keepCookie = true;
              setAsidePasskeySessionId = session.id;
            } else {
              await env.DB.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').bind(session.id).run();
            }
          }
          if (user && sessionMatchesAccess) {
            event.locals.user = user;
            event.locals.sessionId = session.id;
            event.locals.passkeySession = passkeyCredentialId !== null;

            // Sliding session: the DB row's expires_at is the only expiry
            // authority (the token itself carries none). Push it back out to
            // a fresh TTL once it nears expiry so continued use keeps a
            // session alive; sign-out, pause, and offboarding still revoke it
            // immediately elsewhere. Best-effort and isolated from the outer
            // catch below — a renewal failure must never clear a valid cookie.
            // Passkey sessions are never renewed: their short lifetime
            // (PASSKEY_SESSION_TTL_HOURS) is fixed at sign-in.
            try {
              const ttlMs = sessionTtlMs(env as unknown as Record<string, unknown>);
              if (!passkeyCredentialId && shouldRenewSession(Date.parse(session.expires_at), Date.now(), ttlMs)) {
                const ttlHours = Math.max(1, Math.round(ttlMs / (60 * 60 * 1000)));
                event.platform?.context.waitUntil(
                  env.DB.prepare(
                    `UPDATE sessions SET expires_at = datetime('now', '+' || ? || ' hours') WHERE id = ?`,
                  ).bind(ttlHours, session.id).run().catch(() => undefined),
                );
              }
            } catch {
              // Renewal is best-effort; never break the request over it.
            }
          }
        }
      }
      clearInvalidCookie = !event.locals.user && !keepCookie;
    } catch {
      clearInvalidCookie = !keepCookie;
    }
  }

  if (
    env && accessIdentity && access.mode === 'on' && !event.locals.user
    && accessSignInPathAllowed(event.request.method, event.url.pathname)
  ) {
    try {
      assertStrongSessionSecret(env.SESSION_SECRET);
      const established = await establishAccessSession(
        env as unknown as Record<string, unknown> & { DB: D1Database; SESSION_SECRET: string },
        accessIdentity,
        event.request,
        { autoProvision: access.config.autoProvision, secureCookie: isHttps },
      );
      if (established) {
        event.locals.user = established.user;
        event.locals.sessionId = established.sessionId;
        accessSessionCookie = established.cookie;
        clearInvalidCookie = false;
        if (setAsidePasskeySessionId) {
          // The browser's passkey cookie is being replaced by this Access
          // session, so the set-aside passkey session can never be used
          // again: revoke it rather than leave it live in the database.
          await env.DB.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').bind(setAsidePasskeySessionId).run();
        }
      }
    } catch (error) {
      console.error('Access sign-in failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
  const withSessionCookies = (response: Response): Response => {
    if (accessSessionCookie) response.headers.append('Set-Cookie', accessSessionCookie);
    else if (clearInvalidCookie && !setsSessionCookie(response)) {
      // A sign-in route that just issued a fresh session cookie (for example
      // /auth/passkey/verify from a browser holding an expired one) keeps it.
      response.headers.append('Set-Cookie', clearSessionCookie(isHttps));
    }
    return response;
  };

  if (isAdminRequestPath(event.url.pathname) && event.locals.user?.role !== 'manager') {
    const denied = event.locals.user
      ? new Response('Admin access required', { status: 403 })
      : new Response(null, { status: 303, headers: { Location: '/' } });
    // Admin authorization responses must never be shared between callers,
    // including the unauthenticated redirect response.
    return withSessionCookies(secureResponse(denied, true, isHttps));
  }

  const protectedPath = event.url.pathname.startsWith('/mail')
    || isAdminRequestPath(event.url.pathname)
    || (event.url.pathname.startsWith('/api/') && event.url.pathname !== '/api/organization');
  if (env && event.locals.user && protectedPath) {
    const latestPolicy = await env.DB.prepare(
      'SELECT id FROM ict_policy_versions ORDER BY published_at DESC, id DESC LIMIT 1',
    ).first<{ id: string }>();
    if (latestPolicy) {
      const signature = await env.DB.prepare(
        'SELECT id FROM ict_policy_signatures WHERE user_id = ? AND policy_version_id = ?',
      ).bind(event.locals.user.id, latestPolicy.id).first<{ id: string }>();
      if (!signature) {
        const response = event.url.pathname.startsWith('/api/')
          ? Response.json({ error: 'policy_required' }, { status: 403 })
          : new Response(null, { status: 303, headers: { Location: '/policy' } });
        return withSessionCookies(secureResponse(response, true, isHttps));
      }
    }
  }

  if (env && Math.random() < 0.01) {
    event.platform?.context.waitUntil(
      Promise.all([
        env.DB.prepare(`DELETE FROM sessions WHERE revoked = 1 OR expires_at < datetime('now')`).run(),
        env.DB.prepare(`DELETE FROM rate_limits WHERE expires_at < unixepoch('now')`).run(),
        env.DB.prepare(`DELETE FROM enrollment_tokens WHERE consumed_at IS NOT NULL OR expires_at < unixepoch('now')`).run(),
        env.DB.prepare(`DELETE FROM auth_otp_codes WHERE expires_epoch < unixepoch('now')`).run(),
        env.DB.prepare(`DELETE FROM send_idempotency WHERE created_at < datetime('now', '-7 days')`).run(),
        // Own catch: the table exists only once migration 0025 is applied.
        env.DB.prepare(`DELETE FROM passkey_challenges WHERE expires_at < unixepoch('now')`).run().catch(() => undefined),
        // Own catch: the table exists only once migration 0034 is applied.
        env.DB.prepare(`DELETE FROM passkey_pairings WHERE expires_at < unixepoch('now') - 86400`).run().catch(() => undefined),
        ...mcpMaintenanceStatements(env.DB).map((statement) => statement.run()),
      ]).then(() => undefined).catch(() => undefined),
    );
  }

  const locale = env
    ? publicRuntimeConfig(env as unknown as Record<string, unknown>).locale
    : 'en';
  const response = secureResponse(await resolve(event, {
    transformPageChunk: ({ html }) => html.replace('<html lang="en">', `<html lang="${locale}">`),
  }), !!event.locals.user, isHttps);
  if (event.url.pathname === '/bootstrap' || event.url.pathname.startsWith('/enroll/')) {
    response.headers.set('Cache-Control', 'no-store');
    // 'strict-origin', not 'no-referrer'. Both keep the token-bearing path out
    // of the Referer header, but 'no-referrer' also forces the browser to send
    // `Origin: null` on the page's own POST (Fetch, "append a request Origin
    // header"), which SvelteKit's CSRF guard then rejects as cross-site. These
    // two routes are exactly the ones that POST a single-use secret.
    response.headers.set('Referrer-Policy', 'strict-origin');
    appendVary(response.headers, 'Cookie');
  }
  return withSessionCookies(response);
};

export const handleError: HandleServerError = ({ kind, error, event }) => {
  // SvelteKit 3 also sends errors thrown with error(status, message) here.
  // Those are expected: returning nothing keeps their status and message, as
  // SvelteKit 2 did by never calling this hook for them.
  if (kind === 'app') return;
  const reference = crypto.randomUUID();
  console.error('Unhandled request error', {
    reference,
    method: event.request.method,
    path: event.url.pathname,
    error: error instanceof Error ? error.message : kind === 'unknown' ? String(error) : error.message,
  });
  return { message: 'An unexpected error occurred', reference };
};
