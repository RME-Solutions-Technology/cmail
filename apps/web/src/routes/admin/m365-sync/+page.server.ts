import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { applyM365AdminAction, loadM365SyncOverview, parseM365AdminAction } from '#lib/server/m365-sync-admin.js';
import { applyWelcomeAdminAction, loadWelcomeOverview, parseWelcomeAdminAction, welcomeProblemText } from '#lib/server/m365-welcome-admin.js';

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

export const load: PageServerLoad = async ({ platform, locals }) => {
  const env = platform?.env;
  // The admin layout also refuses non-managers, but loads run in parallel and
  // this one writes the profile snapshot, so it checks for itself.
  if (!env || locals.user?.role !== 'manager') return { overview: null, welcome: null };
  const envRecord = env as unknown as { DB: D1Database; EMAIL_SERVICE?: unknown } & Record<string, unknown>;
  const [overview, welcome] = await Promise.all([
    loadM365SyncOverview(env),
    loadWelcomeOverview(envRecord, locals.user?.id ?? null),
  ]);
  return {
    overview,
    welcome: { ...welcome, problemText: welcome.problems.map(welcomeProblemText) },
  };
};

export const actions: Actions = {
  default: async ({ request, platform, locals }) => {
    const env = platform?.env;
    if (!env) return fail(503, { error: 'Service unavailable' });
    if (!locals.user) return fail(401, { error: 'Authentication required' });
    if (locals.user.role !== 'manager') return fail(403, { error: 'Manager role required' });
    const form = await request.formData();
    const welcomeAction = parseWelcomeAdminAction(form.get('action'));
    if (welcomeAction) {
      const envRecord = env as unknown as { DB: D1Database; EMAIL_SERVICE?: unknown } & Record<string, unknown>;
      const result = await applyWelcomeAdminAction(envRecord, locals.user, welcomeAction, {
        scope: field(form, 'scope'),
        expected: field(form, 'expected'),
        note: field(form, 'note'),
        userId: field(form, 'user_id'),
      });
      if (!result.ok) return fail(result.status, { error: result.error });
      return { success: result.message };
    }
    const action = parseM365AdminAction(form.get('action'));
    if (!action) return fail(400, { error: 'Unknown action' });
    const rawRound = form.get('round_id');
    const roundId = typeof rawRound === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(rawRound) ? rawRound : '';
    const result = await applyM365AdminAction(env, locals.user, action, new Date(), roundId);
    if (!result.ok) return fail(result.status, { error: result.error });
    return { success: result.message };
  },
};
