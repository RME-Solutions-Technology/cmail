// Help page for the first sign-in steps in the Microsoft 365 welcome email
// (docs/m365-welcome-emails.md). It needs no cmail session: the hook protects
// only /mail, /admin and /api. That is NOT the same as reachable by anyone when
// Cloudflare Access covers the whole hostname: Access then shows its own login
// page first, so a person who has not signed in yet cannot read this page.
// Add an Access Bypass policy for /help/* (docs/staff-sign-in.md, "Public
// help pages"). RME uses Microsoft sign-in, not Access, so there it is public.
//
// It reads two settings only, to say what the email says: whether passkey
// sign-in is on, and whether the Access login page comes first.
import type { PageServerLoad } from './$types';
import { accessMode } from '#lib/server/access-jwt.js';
import { PASSKEY_SETTING_ENABLED } from '#lib/server/passkeys.js';

export const load: PageServerLoad = async ({ platform, locals, setHeaders }) => {
  // Same for everyone, so a short shared cache is fine for an anonymous
  // visitor. A signed-in visitor's page data carries their user, so it is
  // private to them.
  setHeaders({ 'cache-control': locals?.user ? 'private, max-age=60' : 'public, max-age=60' });
  const env = platform?.env as unknown as ({ DB?: D1Database } & Record<string, unknown>) | undefined;
  if (!env) return { passkeys: false, viaAccess: false };
  const row = await env.DB?.prepare('SELECT value FROM org_settings WHERE key = ?').bind(PASSKEY_SETTING_ENABLED).first<{ value: string }>().catch(() => null);
  const passkeys = row?.value === 'true';
  return { passkeys, viaAccess: accessMode(env).mode === 'on' };
};
