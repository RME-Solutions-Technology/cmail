import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { applyM365AdminAction, loadM365SyncOverview, parseM365AdminAction } from '#lib/server/m365-sync-admin.js';
import { applyWelcomeAdminAction, loadWelcomeOverview, parseWelcomeAdminAction, welcomeProblemText } from '#lib/server/m365-welcome-admin.js';
import { applyM365PermsAdminAction, loadM365PermsOverview, parseM365PermsAdminAction } from '#lib/server/m365-perms-admin.js';
import { applyExchangeMirrorAdminAction, loadExchangeMirrorOverview, parseExchangeMirrorAdminAction } from '#lib/server/exchange-mirror-admin.js';

// One Admin page for everything Microsoft 365. Each section keeps the server
// logic it had as its own page; the named actions below are those pages'
// former default actions, and the result carries the section it came from so
// a message shows only where the button was pressed.

type Section = 'sync' | 'welcome' | 'access' | 'mirror';
type EnvRecord = { DB: D1Database; EMAIL_SERVICE?: unknown } & Record<string, unknown>;

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

function roundIdOf(form: FormData): string {
  const raw = form.get('round_id');
  return typeof raw === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(raw) ? raw : '';
}

export const load: PageServerLoad = async ({ platform, locals }) => {
  const env = platform?.env;
  // The admin layout also refuses non-managers, but loads run in parallel and
  // the sync overview writes the profile snapshot, so this checks for itself.
  if (!env || locals.user?.role !== 'manager') return { sync: null, welcome: null, access: null, feed: null };
  const envRecord = env as unknown as EnvRecord;
  // One section failing to load must not take the others down: each shows "not available" instead.
  const settle = async <T,>(label: string, load: Promise<T>): Promise<T | null> =>
    load.catch((caught: unknown) => { console.error('microsoft-365 admin: section failed to load', label, caught instanceof Error ? caught.name : 'error'); return null; });
  const [sync, welcome, access, feed] = await Promise.all([
    settle('sync', loadM365SyncOverview(env)),
    settle('welcome', loadWelcomeOverview(envRecord, locals.user.id ?? null)),
    settle('access', loadM365PermsOverview(env)),
    settle('feed', loadExchangeMirrorOverview(env)),
  ]);
  return {
    sync,
    welcome: welcome ? { ...welcome, problemText: welcome.problems.map(welcomeProblemText) } : null,
    access,
    feed,
  };
};

type ActionEvent = { request: Request; platform: App.Platform | undefined; locals: App.Locals };

/** The checks every Microsoft 365 action starts with, on the server. */
function gate(section: Section, { platform, locals }: ActionEvent) {
  const env = platform?.env;
  if (!env) return { refusal: fail(503, { section, error: 'Service unavailable' }) } as const;
  if (!locals.user) return { refusal: fail(401, { section, error: 'Authentication required' }) } as const;
  if (locals.user.role !== 'manager') return { refusal: fail(403, { section, error: 'Manager role required' }) } as const;
  return { env, user: locals.user } as const;
}

export const actions: Actions = {
  sync: async (event) => {
    // The welcome buttons post here too; a refusal belongs under the section that was pressed.
    const form = await event.request.formData().catch(() => new FormData());
    const welcomeAction = parseWelcomeAdminAction(form.get('action'));
    const checked = gate(welcomeAction ? 'welcome' : 'sync', event);
    if ('refusal' in checked) return checked.refusal;
    const { env, user } = checked;
    if (welcomeAction) {
      const result = await applyWelcomeAdminAction(env as unknown as EnvRecord, user, welcomeAction, {
        scope: field(form, 'scope'),
        expected: field(form, 'expected'),
        note: field(form, 'note'),
        userId: field(form, 'user_id'),
      });
      if (!result.ok) return fail(result.status, { section: 'welcome', error: result.error });
      return { section: 'welcome', success: result.message };
    }
    const action = parseM365AdminAction(form.get('action'));
    if (!action) return fail(400, { section: 'sync', error: 'Unknown action' });
    const result = await applyM365AdminAction(env, user, action, new Date(), roundIdOf(form));
    if (!result.ok) return fail(result.status, { section: 'sync', error: result.error });
    return { section: 'sync', success: result.message };
  },

  access: async (event) => {
    const checked = gate('access', event);
    if ('refusal' in checked) return checked.refusal;
    const { env, user } = checked;
    const form = await event.request.formData();
    const action = parseM365PermsAdminAction(form.get('action'));
    if (!action) return fail(400, { section: 'access', error: 'Unknown action' });
    const result = await applyM365PermsAdminAction(env, user, action, new Date(), roundIdOf(form));
    if (!result.ok) return fail(result.status, { section: 'access', error: result.error });
    return { section: 'access', success: result.message };
  },

  mirror: async (event) => {
    const checked = gate('mirror', event);
    if ('refusal' in checked) return checked.refusal;
    const { env, user } = checked;
    const form = await event.request.formData();
    const action = parseExchangeMirrorAdminAction(form.get('action'));
    if (!action) return fail(400, { section: 'mirror', error: 'Unknown action' });
    const result = await applyExchangeMirrorAdminAction(env, user, action, {
      stop: form.get('stop'),
      estimateId: form.get('estimateId'),
      messages: form.get('messages'),
      bytes: form.get('bytes'),
      confirmed: form.get('confirmed'),
    });
    if (!result.ok) return fail(result.status, { section: 'mirror', error: result.error });
    return { section: 'mirror', success: result.message };
  },
};
