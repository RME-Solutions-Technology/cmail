import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { isPublicDirectoryEnabled } from '#lib/server/public-directory.js';
import {
  BOOTSTRAP_PROOF_COOKIE,
  bootstrapConfiguration,
  verifyBootstrapProof,
} from '#lib/server/bootstrap.js';
import { passkeyRouteContext } from '#lib/server/passkeys.js';

export const load: PageServerLoad = async ({ locals, platform, cookies, setHeaders, url }) => {
  if (locals.user) throw redirect(303, '/mail');
  setHeaders({ 'Cache-Control': 'no-store', Vary: 'Cookie' });
  const env = platform?.env;
  const configuration = env
    ? bootstrapConfiguration(env as unknown as Record<string, unknown>)
    : null;
  const [publicDirectoryEnabled, existingManager, passkeyRoute] = await Promise.all([
    isPublicDirectoryEnabled(env?.DB),
    env && configuration
      ? env.DB.prepare("SELECT id FROM users WHERE role = 'manager' LIMIT 1").first<{ id: string }>()
      : Promise.resolve(null),
    passkeyRouteContext(env as unknown as (Record<string, unknown> & { DB: D1Database }) | undefined, url),
  ]);

  let bootstrapReady = false;
  const proof = cookies.get(BOOTSTRAP_PROOF_COOKIE);
  if (configuration && !existingManager && proof) {
    const verified = await verifyBootstrapProof(proof, configuration.sessionSecret);
    bootstrapReady = verified?.email === configuration.email;
  }
  if (proof && !bootstrapReady) cookies.delete(BOOTSTRAP_PROOF_COOKIE, { path: '/' });

  return {
    publicDirectoryEnabled,
    bootstrapAvailable: !!configuration && !existingManager,
    bootstrapReady,
    passkeyEnabled: passkeyRoute !== null,
  };
};
