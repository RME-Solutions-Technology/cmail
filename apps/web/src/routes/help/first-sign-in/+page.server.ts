// Public help page (no sign-in): the first sign-in steps people get in the
// Microsoft 365 welcome email (docs/m365-welcome-emails.md). It reads two
// settings only, to say the same thing the email says: whether passkey
// sign-in is on, and whether the Cloudflare Access login page comes first.
import type { PageServerLoad } from './$types';
import { accessMode } from '#lib/server/access-jwt.js';
import { PASSKEY_SETTING_ENABLED } from '#lib/server/passkeys.js';

export const load: PageServerLoad = async ({ platform }) => {
  const env = platform?.env as unknown as ({ DB?: D1Database } & Record<string, unknown>) | undefined;
  if (!env) return { passkeys: false, viaAccess: false };
  const row = await env.DB?.prepare('SELECT value FROM org_settings WHERE key = ?').bind(PASSKEY_SETTING_ENABLED).first<{ value: string }>().catch(() => null);
  const passkeys = row?.value === 'true';
  return { passkeys, viaAccess: accessMode(env).mode === 'on' };
};
