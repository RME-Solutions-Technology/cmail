import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { applyM365PermsAdminAction, loadM365PermsOverview, parseM365PermsAdminAction } from '#lib/server/m365-perms-admin.js';

export const load: PageServerLoad = async ({ platform }) => {
  const env = platform?.env;
  if (!env) return { overview: null };
  return { overview: await loadM365PermsOverview(env) };
};

export const actions: Actions = {
  default: async ({ request, platform, locals }) => {
    const env = platform?.env;
    if (!env) return fail(503, { error: 'Service unavailable' });
    if (!locals.user) return fail(401, { error: 'Authentication required' });
    if (locals.user.role !== 'manager') return fail(403, { error: 'Manager role required' });
    const form = await request.formData();
    const action = parseM365PermsAdminAction(form.get('action'));
    if (!action) return fail(400, { error: 'Unknown action' });
    const rawRound = form.get('round_id');
    const roundId = typeof rawRound === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(rawRound) ? rawRound : '';
    const result = await applyM365PermsAdminAction(env, locals.user, action, new Date(), roundId);
    if (!result.ok) return fail(result.status, { error: result.error });
    return { success: result.message };
  },
};
