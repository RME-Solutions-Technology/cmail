import type { PageServerLoad } from './$types';
import { loadOrgSettings } from '#lib/server/org-settings.js';
import { loadPublicDirectory } from '#lib/server/public-directory.js';

export const load: PageServerLoad = async ({ platform }) => {
  const env = platform?.env;
  const directory = await loadPublicDirectory(env?.DB, env?.MAIL_DOMAIN, env?.M365_TENANT_ID);
  const settings = env ? await loadOrgSettings(env as unknown as Record<string, unknown>) : null;
  return {
    ...directory,
    orgUrl: settings?.orgUrl || '',
  };
};
