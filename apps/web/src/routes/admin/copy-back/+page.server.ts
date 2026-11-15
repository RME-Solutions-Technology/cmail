import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { applyCopyBackAction, loadCopyBackOverview, parseCopyBackAction } from '#lib/server/copy-back-admin.js';

export const load: PageServerLoad = async ({ platform }) => {
  const env = platform?.env;
  if (!env) return { overview: null };
  return { overview: await loadCopyBackOverview(env) };
};

export const actions: Actions = {
  default: async ({ request, platform, locals }) => {
    const env = platform?.env;
    if (!env) return fail(503, { error: 'Service unavailable' });
    if (!locals.user) return fail(401, { error: 'Authentication required' });
    if (locals.user.role !== 'manager') return fail(403, { error: 'Manager role required' });
    const form = await request.formData();
    const action = parseCopyBackAction(form.get('action'));
    if (!action) return fail(400, { error: 'Unknown action' });
    const result = await applyCopyBackAction(env, locals.user, action, {
      from: form.get('from'),
      to: form.get('to'),
      target: form.get('target'),
      folders: form.getAll('folders').slice(0, 10),
      confirm: form.get('confirm'),
    });
    if (!result.ok) return fail(result.status, { error: result.error });
    return { success: result.message };
  },
};
