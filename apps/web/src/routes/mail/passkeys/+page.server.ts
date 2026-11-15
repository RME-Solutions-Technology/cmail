import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  MANAGE_REFUSAL_MESSAGES,
  REGISTRATION_FRESH_MINUTES,
  listPasskeys,
  manageRefusal,
  passkeyRouteContext,
  removeOwnPasskey,
} from '#lib/server/passkeys.js';

type PasskeyEnv = Record<string, unknown> & { DB: D1Database };

export const load: PageServerLoad = async ({ locals, platform, url, setHeaders }) => {
  if (!locals.user) throw redirect(303, '/');
  const env = platform?.env as unknown as PasskeyEnv | undefined;
  // Hidden entirely while the manager switch is off.
  if (!env || !await passkeyRouteContext(env, url)) throw error(404, 'Not found');
  setHeaders({ 'Cache-Control': 'private, no-store' });
  const [passkeys, addRefusal, removeRefusal] = await Promise.all([
    listPasskeys(env.DB, locals.user.id),
    manageRefusal(env.DB, locals.user.id, locals.sessionId, { requireFresh: true }),
    manageRefusal(env.DB, locals.user.id, locals.sessionId, { requireFresh: false }),
  ]);
  return {
    passkeys,
    canRemove: removeRefusal === null,
    canAdd: addRefusal === null,
    addBlockedReason: addRefusal ? MANAGE_REFUSAL_MESSAGES[addRefusal] : '',
    freshMinutes: REGISTRATION_FRESH_MINUTES,
    passkeySignInUrl: `${url.origin}/auth/passkey`,
  };
};

export const actions: Actions = {
  remove: async ({ locals, platform, url, request }) => {
    if (!locals.user) throw redirect(303, '/');
    const env = platform?.env as unknown as PasskeyEnv | undefined;
    if (!env || !await passkeyRouteContext(env, url)) return fail(404, { error: 'Passkey sign-in is off.' });
    const form = await request.formData();
    const result = await removeOwnPasskey(
      env,
      locals.user,
      locals.sessionId,
      form.get('credential_id'),
      (request.headers.get('cf-connecting-ip') || '').slice(0, 64),
      platform?.context?.waitUntil ? (promise) => platform.context.waitUntil(promise) : undefined,
    );
    if (!result.ok) return fail(result.status, { error: result.error });
    return { success: result.message };
  },
};
