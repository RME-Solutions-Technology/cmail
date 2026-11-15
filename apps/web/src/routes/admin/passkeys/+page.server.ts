import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { accessMode } from '#lib/server/access-jwt.js';
import { applyPasskeyAdminAction, loadPasskeyAdminOverview, parsePasskeyAdminAction } from '#lib/server/passkeys.js';

type PasskeyEnv = Record<string, unknown> & { DB: D1Database };

export const load: PageServerLoad = async ({ platform }) => {
  const env = platform?.env as unknown as PasskeyEnv | undefined;
  if (!env) return { overview: null, accessOn: false };
  return {
    overview: await loadPasskeyAdminOverview(env),
    accessOn: accessMode(env).mode !== 'off',
  };
};

export const actions: Actions = {
  default: async ({ request, platform, locals }) => {
    const env = platform?.env as unknown as PasskeyEnv | undefined;
    if (!env) return fail(503, { error: 'Service unavailable' });
    if (!locals.user) return fail(401, { error: 'Authentication required' });
    if (locals.user.role !== 'manager') return fail(403, { error: 'Manager role required' });
    const form = await request.formData();
    const action = parsePasskeyAdminAction(form.get('action'));
    if (!action) return fail(400, { error: 'Unknown action' });
    const result = await applyPasskeyAdminAction(
      env,
      locals.user,
      action,
      form.get('user_id'),
      (request.headers.get('cf-connecting-ip') || '').slice(0, 64),
      platform?.context?.waitUntil ? (promise) => platform.context.waitUntil(promise) : undefined,
    );
    if (!result.ok) return fail(result.status, { error: result.error });
    return { success: result.message };
  },
};
