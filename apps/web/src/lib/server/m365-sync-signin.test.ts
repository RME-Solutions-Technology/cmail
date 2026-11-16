import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from './mcp/testing/harness';
import { AccessKeyStore } from './access-jwt';
import { bindSyncLinkedMicrosoftIdentity, syncSignInTenant, verifyMicrosoftIdToken } from './m365-sync-signin';

// First sign-in of a synced person with "Sign in with Microsoft". The ID
// token is signed here with a test RSA key served as the tenant's JWKS.
// Placeholder GUIDs only.

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000bb';
const CLIENT = '00000000-0000-4000-8000-0000000000cc';
const OID = '00000000-0000-4000-8000-000000000001';
const SUB = 'pairwise-subject-alice';
const NOW = Date.parse('2026-11-16T00:00:00Z');
const NONCE = 'n'.repeat(43);
const OTHER_NONCE = 'o'.repeat(43);
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;

let keyPair: CryptoKeyPair;
let jwk: JsonWebKey;

function b64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}, key: CryptoKey = keyPair.privateKey): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1', ...header }));
  const body = b64url(JSON.stringify(claims));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(signature)}`;
}

function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(NOW / 1000);
  return { ver: '2.0', iss: ISSUER, aud: CLIENT, tid: TENANT, oid: OID, sub: SUB, nonce: NONCE, iat: now - 10, nbf: now - 10, exp: now + 3600, ...extra };
}

function keyStore(): { store: AccessKeyStore; urls: string[] } {
  const urls: string[] = [];
  const store = new AccessKeyStore(async (url) => {
    urls.push(url);
    return Response.json({ keys: [{ ...jwk, kid: 'k1', use: 'sig' }] });
  });
  return { store, urls };
}

beforeAll(async () => {
  keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as JsonWebKey;
});

function setup(options: { sync?: boolean; role?: string; status?: string; scope?: string } = {}) {
  const { d1, sqlite } = createTestDatabase();
  if (options.sync ?? true) sqlite.prepare(`INSERT INTO org_settings (key, value) VALUES ('m365_sync_enabled', 'true')`).run();
  sqlite.prepare(`INSERT INTO users (id, email, role, status) VALUES ('alice', 'alice@example.test', ?, ?)`).run(options.role ?? 'standard', options.status ?? 'pending');
  sqlite.prepare(`INSERT INTO m365_sync_links (object_id, kind, user_id, source_state) VALUES (?, 'person', 'alice', ?)`).run(OID, options.scope ?? 'in_scope');
  const env = { M365_TENANT_ID: TENANT, MICROSOFT_TENANT_ID: 'organizations', MICROSOFT_CLIENT_ID: CLIENT };
  const identities = () => sqlite.prepare('SELECT provider, subject, user_id FROM user_identities').all();
  const audits = () => sqlite.prepare(`SELECT event_type, target, detail FROM audit_log WHERE event_type LIKE 'auth.sync_link_%'`).all() as Array<{ event_type: string; target: string | null; detail: string }>;
  const ks = keyStore();
  const run = async (token: unknown, subject = SUB, nonce: string | undefined = NONCE) => bindSyncLinkedMicrosoftIdentity(d1, env, { idToken: token, subject, nonce, clientIp: '192.0.2.1' }, { nowMs: NOW, keyStore: ks.store });
  return { d1, sqlite, env, identities, audits, run, ks };
}

describe('Microsoft 365 sync first sign-in', () => {
  it('binds the Microsoft identity to the synced account on a verified oid and tid, and audits it', async () => {
    const t = setup();
    const result = await t.run(await sign(claims()));
    expect(result).toEqual({ status: 'bound', userId: 'alice' });
    expect(t.identities()).toEqual([{ provider: 'microsoft', subject: SUB, user_id: 'alice' }]);
    expect(t.sqlite.prepare(`SELECT auth_provider FROM users WHERE id = 'alice'`).get()).toEqual({ auth_provider: 'microsoft' });
    expect(t.audits()).toEqual([expect.objectContaining({ event_type: 'auth.sync_link_bound', target: 'alice' })]);
    // Keys come from the configured tenant's endpoint only.
    expect(t.ks.urls).toEqual([`https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys?appid=${CLIENT}`]);
  });

  it('changes nothing while the sync is off', async () => {
    const t = setup({ sync: false });
    expect(await t.run(await sign(claims()))).toEqual({ status: 'not_applicable' });
    expect(t.identities()).toEqual([]);
    expect(t.audits()).toEqual([]);
    expect(t.ks.urls).toEqual([]);
  });

  it('refuses a token from another tenant', async () => {
    const t = setup();
    // Signed as the other tenant: its issuer cannot match the configured one.
    const result = await t.run(await sign(claims({ tid: OTHER_TENANT, iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` })));
    expect(result).toMatchObject({ status: 'refused', reason: 'id_token_invalid', deny: 'enrollment_required' });
    // Right issuer but a different tid claim.
    expect(await t.run(await sign(claims({ tid: OTHER_TENANT })))).toMatchObject({ status: 'refused', reason: 'wrong_tenant' });
    expect(t.identities()).toEqual([]);
    // One row per denied sign-in is written by the callback, not here.
    expect(t.audits()).toEqual([]);
  });

  it('refuses an oid the sync has not linked, and never matches by email', async () => {
    const t = setup();
    const result = await t.run(await sign(claims({ oid: '00000000-0000-4000-8000-000000000099', email: 'alice@example.test', preferred_username: 'alice@example.test' })));
    expect(result).toMatchObject({ status: 'refused', reason: 'not_linked', deny: 'enrollment_required' });
    expect(t.identities()).toEqual([]);
  });

  it('never binds a manager account', async () => {
    const t = setup({ role: 'manager' });
    expect(await t.run(await sign(claims()))).toMatchObject({ status: 'refused', reason: 'manager', deny: 'identity_conflict', userId: 'alice' });
    expect(t.identities()).toEqual([]);
  });

  it('refuses paused and offboarded accounts, and people out of scope', async () => {
    for (const status of ['paused', 'offboarded']) {
      const t = setup({ status });
      expect(await t.run(await sign(claims()))).toMatchObject({ status: 'refused', reason: 'account_suspended', deny: 'account_suspended' });
      expect(t.identities()).toEqual([]);
    }
    const out = setup({ scope: 'out_of_scope' });
    expect(await out.run(await sign(claims()))).toMatchObject({ status: 'refused', reason: 'out_of_scope' });
  });

  it('refuses an account already bound to a different subject', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO user_identities (provider, subject, user_id) VALUES ('microsoft', 'someone-else', 'alice')`).run();
    expect(await t.run(await sign(claims()))).toMatchObject({ status: 'refused', reason: 'already_bound', deny: 'identity_conflict' });
    expect(t.identities()).toEqual([{ provider: 'microsoft', subject: 'someone-else', user_id: 'alice' }]);
  });

  it('refuses when the ID token subject differs from the UserInfo subject', async () => {
    const t = setup();
    expect(await t.run(await sign(claims()), 'another-subject')).toMatchObject({ status: 'refused', reason: 'subject_mismatch' });
    expect(t.identities()).toEqual([]);
  });

  it('refuses a missing, unsigned, mis-signed, guest, expired or wrong-audience token', async () => {
    const t = setup();
    const other = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const now = Math.floor(NOW / 1000);
    const bad = [
      undefined,
      '',
      `${b64url(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${b64url(JSON.stringify(claims()))}.`,
      await sign(claims(), {}, other.privateKey),
      await sign(claims(), { alg: 'HS256' }),
      await sign(claims({ aud: '00000000-0000-4000-8000-0000000000dd' })),
      await sign(claims({ exp: now - 600 })),
      await sign(claims({ nbf: now + 600 })),
      await sign(claims({ idp: 'https://sts.windows.net/00000000-0000-4000-8000-0000000000ee/' })),
      await sign(claims({ ver: '1.0' })),
      await sign(claims({ oid: 'not-a-guid' })),
    ];
    for (const token of bad) {
      expect(await t.run(token)).toMatchObject({ status: 'refused', reason: 'id_token_invalid' });
    }
    expect(t.identities()).toEqual([]);
  });

  it('binds nothing when the account changes between the check and the bind', async () => {
    const t = setup();
    const token = await sign(claims());
    const original = t.d1.batch.bind(t.d1);
    (t.d1 as unknown as { batch: typeof original }).batch = async (statements) => {
      t.sqlite.prepare(`UPDATE users SET status = 'paused' WHERE id = 'alice'`).run();
      return original(statements);
    };
    expect(await t.run(token)).toMatchObject({ status: 'refused', reason: 'bind_conflict' });
    expect(t.identities()).toEqual([]);
  });
});

describe('sync sign-in tenant', () => {
  it('uses M365_TENANT_ID or a single-tenant MICROSOFT_TENANT_ID, and refuses a disagreement', () => {
    expect(syncSignInTenant({ M365_TENANT_ID: TENANT })).toBe(TENANT);
    expect(syncSignInTenant({ MICROSOFT_TENANT_ID: TENANT })).toBe(TENANT);
    expect(syncSignInTenant({ M365_TENANT_ID: TENANT, MICROSOFT_TENANT_ID: 'common' })).toBe(TENANT);
    expect(syncSignInTenant({ M365_TENANT_ID: TENANT, MICROSOFT_TENANT_ID: OTHER_TENANT })).toBeNull();
    expect(syncSignInTenant({ MICROSOFT_TENANT_ID: 'common' })).toBeNull();
  });

  it('verifies a good token on its own', async () => {
    const { store } = keyStore();
    expect(await verifyMicrosoftIdToken(await sign(claims({ aud: CLIENT.toUpperCase() })), { tenantId: TENANT, clientId: CLIENT, nonce: NONCE }, { nowMs: NOW, keyStore: store }))
      .toEqual({ sub: SUB, oid: OID, tid: TENANT });
  });
});

describe('OIDC nonce', () => {
  it('refuses when the login request left no nonce (missing or malformed cookie)', async () => {
    const t = setup();
    // An absent cookie reaches the callback as an empty value.
    expect(await t.run(await sign(claims()), SUB, '')).toMatchObject({ status: 'refused', reason: 'nonce_missing' });
    expect(await t.run(await sign(claims()), SUB, 'short')).toMatchObject({ status: 'refused', reason: 'nonce_missing' });
    expect(t.identities()).toEqual([]);
  });

  it('refuses a replayed token whose nonce belongs to another login request', async () => {
    const t = setup();
    const replayed = await sign(claims({ nonce: OTHER_NONCE }));
    expect(await t.run(replayed)).toMatchObject({ status: 'refused', reason: 'id_token_invalid' });
    expect(await t.run(await sign(claims({ nonce: undefined })))).toMatchObject({ status: 'refused', reason: 'id_token_invalid' });
    expect(t.identities()).toEqual([]);
    // The same token with its own nonce would have been accepted.
    expect(await t.run(replayed, SUB, OTHER_NONCE)).toMatchObject({ status: 'bound' });
  });
});