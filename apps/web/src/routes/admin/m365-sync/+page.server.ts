import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { applyM365AdminAction, loadM365SyncOverview, parseM365AdminAction } from '#lib/server/m365-sync-admin.js';

export const load: PageServerLoad = async ({ platform }) => {
  const env = platform?.env;
  if (!env) return { overview: null };
  return { overview: await loadM365SyncOverview(env) };
};

export const actions: Actions = {
  default: async ({ request, platform, locals }) => {
    const env = platform?.env;
    if (!env) return fail(503, { error: 'Service unavailable' });
    if (!locals.user) return fail(401, { error: 'Authentication required' });
    if (locals.user.role !== 'manager') return fail(403, { error: 'Manager role required' });
    const action = parseM365AdminAction((await request.formData()).get('action'));
    if (!action) return fail(400, { error: 'Unknown action' });
    const result = await applyM365AdminAction(env, locals.user, action);
    if (!result.ok) return fail(result.status, { error: result.error });
    return { success: result.message };
  },
};
