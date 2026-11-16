import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { applyExchangeMirrorAdminAction, loadExchangeMirrorOverview, parseExchangeMirrorAdminAction } from '#lib/server/exchange-mirror-admin.js';

export const load: PageServerLoad = async ({ platform }) => {
  const env = platform?.env;
  if (!env) return { overview: null };
  return { overview: await loadExchangeMirrorOverview(env) };
};

export const actions: Actions = {
  default: async ({ request, platform, locals }) => {
    const env = platform?.env;
    if (!env) return fail(503, { error: 'Service unavailable' });
    if (!locals.user) return fail(401, { error: 'Authentication required' });
    if (locals.user.role !== 'manager') return fail(403, { error: 'Manager role required' });
    const form = await request.formData();
    const action = parseExchangeMirrorAdminAction(form.get('action'));
    if (!action) return fail(400, { error: 'Unknown action' });
    const result = await applyExchangeMirrorAdminAction(env, locals.user, action, { days: form.get('days') });
    if (!result.ok) return fail(result.status, { error: result.error });
    return { success: result.message };
  },
};
