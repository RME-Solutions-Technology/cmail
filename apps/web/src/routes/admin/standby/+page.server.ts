import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { applyStandbyAdminAction, loadStandbyOverview, parseStandbyAdminAction } from '#lib/server/standby-admin.js';

export const load: PageServerLoad = async ({ platform }) => {
  const env = platform?.env;
  if (!env) return { overview: null };
  return { overview: await loadStandbyOverview(env) };
};

export const actions: Actions = {
  default: async ({ request, platform, locals }) => {
    const env = platform?.env;
    if (!env) return fail(503, { error: 'Service unavailable' });
    if (!locals.user) return fail(401, { error: 'Authentication required' });
    if (locals.user.role !== 'manager') return fail(403, { error: 'Manager role required' });
    const form = await request.formData();
    const action = parseStandbyAdminAction(form.get('action'));
    if (!action) return fail(400, { error: 'Unknown action' });
    const result = await applyStandbyAdminAction(env, locals.user, action);
    if (!result.ok) return fail(result.status, { error: result.error });
    return { success: result.message };
  },
};
