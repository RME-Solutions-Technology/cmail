import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@cmail/shared/types';
import { PROVIDER_PREFERENCE_COOKIE } from '#lib/server/provider-preference.js';

const mocks = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  fetchUserInfo: vi.fn(),
  findBoundUser: vi.fn(),
  findEnrollment: vi.fn(),
  enrollmentFailure: vi.fn(),
  bindEnrolledIdentity: vi.fn(),
  bootstrapConfiguration: vi.fn(),
  verifyBootstrapProof: vi.fn(),
  provisionBootstrapManager: vi.fn(),
  createSessionToken: vi.fn(),
  audit: vi.fn(),
  loadOrgSettings: vi.fn(),
  requestCountry: vi.fn(),
  signInCountryGate: vi.fn(),
  recordTravelRequest: vi.fn(),
  bindSyncLinkedMicrosoftIdentity: vi.fn(),
}));

vi.mock('#lib/server/auth.js', () => ({
  OAUTH_NONCE_COOKIE_PREFIX: 'cmail_oauth_nonce_',
  exchangeCode: mocks.exchangeCode,
  fetchUserInfo: mocks.fetchUserInfo,
  getOAuthCallbackUrl: vi.fn(() => 'https://mail.example.com/auth/callback/google'),
  isAuthProvider: vi.fn((value: string) => value === 'google' || value === 'microsoft'),
}));
vi.mock('#lib/server/identity.js', () => ({
  ENROLLMENT_COOKIE: 'cmail_enrollment',
  bindEnrolledIdentity: mocks.bindEnrolledIdentity,
  enrollmentFailure: mocks.enrollmentFailure,
  findBoundUser: mocks.findBoundUser,
  findEnrollment: mocks.findEnrollment,
}));
vi.mock('#lib/server/bootstrap.js', () => ({
  BOOTSTRAP_PROOF_COOKIE: 'cmail_bootstrap_proof',
  bootstrapConfiguration: mocks.bootstrapConfiguration,
  provisionBootstrapManager: mocks.provisionBootstrapManager,
  verifyBootstrapProof: mocks.verifyBootstrapProof,
}));
vi.mock('#lib/server/session.js', () => ({
  buildSessionCookie: vi.fn(() => 'cmail_session=signed; Path=/; HttpOnly'),
  createSessionToken: mocks.createSessionToken,
}));
vi.mock('#lib/server/config.js', () => ({
  assertStrongSessionSecret: vi.fn(),
  maxSessionsPerUser: vi.fn(() => 5),
  sessionTtlMs: vi.fn(() => 3_600_000),
}));
vi.mock('#lib/server/validation.js', () => ({
  normalizeDomain: vi.fn((value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : null),
  normalizeEmail: vi.fn((value: unknown) => typeof value === 'string' && value.includes('@') ? value.trim().toLowerCase() : null),
}));
vi.mock('#lib/server/db.js', () => ({ audit: mocks.audit }));
vi.mock('#lib/server/org-settings.js', () => ({ loadOrgSettings: mocks.loadOrgSettings }));
vi.mock('#lib/server/travel.js', () => ({
  requestCountry: mocks.requestCountry,
  signInCountryGate: mocks.signInCountryGate,
  recordTravelRequest: mocks.recordTravelRequest,
}));

vi.mock('#lib/server/m365-sync-signin.js', () => ({ bindSyncLinkedMicrosoftIdentity: mocks.bindSyncLinkedMicrosoftIdentity }));

import { GET } from './[provider]/+server';

const returningUser: User = {
  id: 'user-1',
  email: 'original@example.com',
  display_name: 'Returning User',
  role: 'standard',
  status: 'active',
  auth_provider: 'google',
  created_at: '2026-08-03 00:00:00',
  updated_at: '2026-08-03 00:00:00',
  last_sign_in: null,
  last_auth_country: null,
};

function fakeDb(options: { existingManager?: { id: string } | null; enrolledUser?: User | null; publishedPolicy?: boolean } = {}) {
  const prepare = vi.fn((sql: string) => {
    const statement = {
      bind: vi.fn(() => statement),
      run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      first: vi.fn(async () => {
        if (sql.includes("role = 'manager'")) return options.existingManager ?? null;
        if (sql.includes('SELECT * FROM users WHERE id = ?')) return options.enrolledUser ?? null;
        if (sql.includes('FROM ict_policy_versions')) return options.publishedPolicy ? { id: 'policy-1' } : null;
        return null;
      }),
    };
    return statement;
  });
  return { prepare } as unknown as D1Database;
}

function callbackEvent(cookieValues: Record<string, string> = {}, db = fakeDb(), provider = 'google') {
  const cookies = {
    get: vi.fn((name: string): string | undefined => {
      if (name === `cmail_oauth_state_${provider}`) return 'state-value';
      if (name === `cmail_oauth_verifier_${provider}`) return 'verifier-value';
      return cookieValues[name];
    }),
    delete: vi.fn(),
  };
  return {
    event: {
      params: { provider },
      url: new URL(`https://mail.example.com/auth/callback/${provider}?code=code-value&state=state-value`),
      platform: {
        env: {
          DB: db,
          APP_URL: 'https://mail.example.com',
          SESSION_SECRET: '9b31cc4df6ca42c3a60cedd53d63a90f8de45aae0b72a749',
          MAIL_DOMAIN: 'example.com',
        },
      },
      cookies,
      request: new Request('https://mail.example.com/auth/callback/google', {
        headers: { 'cf-connecting-ip': '192.0.2.10' },
      }),
    },
    cookies,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exchangeCode.mockResolvedValue({ access_token: 'access-token', expires_in: 3600 });
  mocks.fetchUserInfo.mockResolvedValue({
    subject: 'immutable-subject',
    email: 'changed@example.net',
    name: 'Returning User',
    provider: 'google',
    emailVerified: false,
  });
  mocks.findBoundUser.mockResolvedValue(null);
  mocks.findEnrollment.mockResolvedValue(null);
  mocks.enrollmentFailure.mockReturnValue(null);
  mocks.bindEnrolledIdentity.mockResolvedValue(undefined);
  mocks.bootstrapConfiguration.mockReturnValue(null);
  mocks.verifyBootstrapProof.mockResolvedValue(null);
  mocks.provisionBootstrapManager.mockResolvedValue(returningUser);
  mocks.createSessionToken.mockResolvedValue({
    token: 'signed-session',
    hash: 'session-hash',
    expiresAt: new Date('2026-08-03T01:00:00Z'),
    sessionId: 'session-1',
  });
  mocks.audit.mockResolvedValue(undefined);
  mocks.loadOrgSettings.mockResolvedValue({ appUrl: 'https://mail.example.com', signInCountries: [] });
  mocks.requestCountry.mockReturnValue('AU');
  mocks.signInCountryGate.mockResolvedValue({ allowed: true });
  mocks.recordTravelRequest.mockResolvedValue(undefined);
  mocks.bindSyncLinkedMicrosoftIdentity.mockResolvedValue({ status: 'not_applicable' });
});

describe('OAuth callback authorization branches', () => {
  it('passes a code of exactly 4096 characters to the token exchange', async () => {
    mocks.findBoundUser.mockResolvedValue(returningUser);
    const { event } = callbackEvent();
    event.url.searchParams.set('code', 'c'.repeat(4096));
    await GET(event as never);
    expect(mocks.exchangeCode).toHaveBeenCalledWith('google', expect.anything(), 'c'.repeat(4096), expect.any(String), 'verifier-value');
  });

  it.each(['token exchange', 'UserInfo'])('redirects to oauth_failed, reading no intent and signing no one in, when the %s fails', async (stage) => {
    if (stage === 'token exchange') mocks.exchangeCode.mockRejectedValue(new Error('Token exchange failed with status 400'));
    else mocks.fetchUserInfo.mockRejectedValue(new Error('UserInfo request failed with status 401'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { event, cookies } = callbackEvent({ cmail_enrollment: 'synthetic-intent' });
      await expect(GET(event as never)).rejects.toMatchObject({ status: 303, location: '/?error=oauth_failed' });
      expect(cookies.get).not.toHaveBeenCalledWith('cmail_enrollment');
      expect(mocks.findBoundUser).not.toHaveBeenCalled();
      expect(mocks.createSessionToken).not.toHaveBeenCalled();
      // Only the error type is logged, never the message or the code.
      expect(consoleError).toHaveBeenCalledWith('OAuth callback failed', { provider: 'google', errorType: 'Error' });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('logs UnknownError for a thrown non-Error value', async () => {
    mocks.exchangeCode.mockRejectedValue('token endpoint said no');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { event } = callbackEvent();
      await expect(GET(event as never)).rejects.toMatchObject({ location: '/?error=oauth_failed' });
      expect(consoleError).toHaveBeenCalledWith('OAuth callback failed', { provider: 'google', errorType: 'UnknownError' });
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each(['google', 'microsoft'])('remembers only the successful returning %s provider in a bounded host-only cookie', async (provider) => {
    mocks.findBoundUser.mockResolvedValue(returningUser);
    const { event } = callbackEvent({}, fakeDb(), provider);
    const response = await GET(event as never) as Response;
    const preference = response.headers.getSetCookie().find((value) => value.startsWith(`${PROVIDER_PREFERENCE_COOKIE}=`));
    expect(preference).toBe(`${PROVIDER_PREFERENCE_COOKIE}=${provider}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
    expect(preference).not.toContain('Domain=');
    expect(preference).not.toContain(returningUser.email);
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it('does not create a preference cookie on insecure development HTTP', async () => {
    mocks.findBoundUser.mockResolvedValue(returningUser);
    const { event } = callbackEvent();
    event.url.protocol = 'http:';
    const response = await GET(event as never) as Response;
    expect(response.headers.getSetCookie().some((value) => value.startsWith(PROVIDER_PREFERENCE_COOKIE))).toBe(false);
  });

  it('does not remember a provider during first enrollment', async () => {
    mocks.findEnrollment.mockResolvedValue({
      enrollment_id: 'enrollment-1', user_id: returningUser.id, email: returningUser.email,
      role: 'standard', status: 'pending', expires_at: 2_000_000_000,
      consumed_at: null, bound_provider: null,
    });
    const { event } = callbackEvent({ cmail_enrollment: 'synthetic-intent' }, fakeDb({ enrolledUser: returningUser }));
    const response = await GET(event as never) as Response;
    expect(response.status).toBe(303);
    expect(mocks.bindEnrolledIdentity).toHaveBeenCalledOnce();
    expect(response.headers.getSetCookie().some((value) => value.startsWith(PROVIDER_PREFERENCE_COOKIE))).toBe(false);
  });

  it.each(['wrong_state', 'missing_verifier', 'provider_error', 'missing_code', 'oversized_code'])('rejects %s before reading identity or enrollment intent', async (failure) => {
    const { event, cookies } = callbackEvent({ cmail_enrollment: 'synthetic-intent' });
    if (failure === 'wrong_state') event.url.searchParams.set('state', 'wrong');
    if (failure === 'missing_code') event.url.searchParams.delete('code');
    if (failure === 'oversized_code') event.url.searchParams.set('code', 'c'.repeat(4097));
    if (failure === 'provider_error') event.url.searchParams.set('error', 'login_required');
    if (failure === 'missing_verifier') cookies.get.mockImplementation((name) => name === 'cmail_oauth_state_google' ? 'state-value' : undefined);
    await expect(GET(event as never)).rejects.toMatchObject({ location: '/?error=invalid_state' });
    expect(cookies.delete).toHaveBeenCalledWith('cmail_oauth_state_google', { path: '/' });
    expect(cookies.delete).toHaveBeenCalledWith('cmail_oauth_verifier_google', { path: '/' });
    expect(cookies.get).not.toHaveBeenCalledWith('cmail_enrollment');
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.findBoundUser).not.toHaveBeenCalled();
    expect(mocks.createSessionToken).not.toHaveBeenCalled();
  });

  it('refuses an unbound provider subject even when its email and Access headers match a staff address', async () => {
    const { event } = callbackEvent();
    event.request.headers.set('Cf-Access-Authenticated-User-Email', returningUser.email);
    event.request.headers.set('Cf-Access-Jwt-Assertion', 'unverified-assertion');
    mocks.fetchUserInfo.mockResolvedValue({ subject: 'other-subject', provider: 'google', email: returningUser.email, emailVerified: true, name: 'Other User' });
    await expect(GET(event as never)).rejects.toMatchObject({ location: '/?error=enrollment_required' });
    expect(mocks.findBoundUser).toHaveBeenCalledWith(event.platform.env.DB, 'google', 'other-subject');
    expect(mocks.bindEnrolledIdentity).not.toHaveBeenCalled();
    expect(mocks.provisionBootstrapManager).not.toHaveBeenCalled();
    expect(mocks.createSessionToken).not.toHaveBeenCalled();
  });

  it.each(['paused', 'offboarded'] as const)('refuses an existing %s account without issuing a session', async (status) => {
    mocks.findBoundUser.mockResolvedValue({ ...returningUser, status });
    const { event } = callbackEvent();
    await expect(GET(event as never)).rejects.toMatchObject({ location: '/?error=account_suspended' });
    expect(mocks.createSessionToken).not.toHaveBeenCalled();
  });

  it('retains the policy gate after a bound provider signs in', async () => {
    mocks.findBoundUser.mockResolvedValue(returningUser);
    const { event } = callbackEvent({}, fakeDb({ publishedPolicy: true }));
    const response = await GET(event as never) as Response;
    expect(response.headers.get('Location')).toBe('/policy');
  });

  it('allows a returning identity by provider + subject even when UserInfo email changed or is unverified', async () => {
    const db = fakeDb();
    mocks.findBoundUser.mockResolvedValue(returningUser);
    const { event } = callbackEvent({}, db);

    const response = await GET(event as never) as Response;
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/mail');
    expect(mocks.findBoundUser).toHaveBeenCalledWith(db, 'google', 'immutable-subject');
    expect(mocks.findEnrollment).not.toHaveBeenCalled();
  });

  it('rejects an unbound identity when no secure enrollment or bootstrap intent exists', async () => {
    const { event } = callbackEvent();
    await expect(GET(event as never)).rejects.toMatchObject({
      status: 303,
      location: '/?error=enrollment_required',
    });
    expect(mocks.findBoundUser).toHaveBeenCalledWith(expect.anything(), 'google', 'immutable-subject');
  });

  it('rejects an enrollment email mismatch without binding or auditing capabilities', async () => {
    const rawToken = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
    const record = {
      enrollment_id: 'enrollment-1',
      user_id: 'pending-user',
      email: 'invited@example.com',
      role: 'standard',
      status: 'pending',
      expires_at: 2_000_000_000,
      consumed_at: null,
      bound_provider: null,
    };
    mocks.findEnrollment.mockResolvedValue(record);
    mocks.enrollmentFailure.mockReturnValue('enrollment_email_mismatch');
    const { event } = callbackEvent({ cmail_enrollment: rawToken });

    await expect(GET(event as never)).rejects.toMatchObject({
      status: 303,
      location: '/?error=enrollment_email_mismatch',
    });
    expect(mocks.bindEnrolledIdentity).not.toHaveBeenCalled();
    const audited = JSON.stringify(mocks.audit.mock.calls);
    expect(audited).not.toContain(rawToken);
    expect(audited).not.toContain('immutable-subject');
    expect(audited).not.toContain('changed@example.net');
  });

  it('maps a concurrent enrollment binding failure to an identity conflict', async () => {
    const record = {
      enrollment_id: 'enrollment-1', user_id: 'pending-user', email: 'changed@example.net',
      role: 'standard', status: 'pending', expires_at: 2_000_000_000,
      consumed_at: null, bound_provider: null,
    };
    mocks.findEnrollment.mockResolvedValue(record);
    mocks.bindEnrolledIdentity.mockRejectedValue(new Error('unique constraint'));
    const { event } = callbackEvent({
      cmail_enrollment: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
    });

    await expect(GET(event as never)).rejects.toMatchObject({
      status: 303,
      location: '/?error=identity_conflict',
    });
  });

  it('provisions the first manager only from a matching signed proof and provider email', async () => {
    const configuration = {
      email: 'admin@example.com', token: 'strong-token', sessionSecret: 'session-secret',
    };
    const manager = { ...returningUser, id: 'manager-1', email: configuration.email, role: 'manager' as const };
    mocks.fetchUserInfo.mockResolvedValue({
      subject: 'bootstrap-subject', email: configuration.email, name: 'First Manager',
      provider: 'google', emailVerified: true,
    });
    mocks.bootstrapConfiguration.mockReturnValue(configuration);
    mocks.verifyBootstrapProof.mockResolvedValue({
      version: 1, email: configuration.email, expiresAt: 2_000_000_000, nonce: crypto.randomUUID(),
    });
    mocks.provisionBootstrapManager.mockResolvedValue(manager);
    const db = fakeDb({ existingManager: null });
    const { event } = callbackEvent({ cmail_bootstrap_proof: 'signed-proof' }, db);

    const response = await GET(event as never) as Response;
    expect(response.status).toBe(303);
    expect(mocks.provisionBootstrapManager).toHaveBeenCalledWith(db, expect.objectContaining({
      email: configuration.email,
      provider: 'google',
      subject: 'bootstrap-subject',
    }));
    expect(response.headers.getSetCookie().some((value) => value.startsWith(PROVIDER_PREFERENCE_COOKIE))).toBe(false);
  });

  it('rejects bootstrap when UserInfo email does not match the proof', async () => {
    const configuration = {
      email: 'admin@example.com', token: 'strong-token', sessionSecret: 'session-secret',
    };
    mocks.fetchUserInfo.mockResolvedValue({
      subject: 'bootstrap-subject', email: 'other@example.com', name: 'Other Person',
      provider: 'google', emailVerified: true,
    });
    mocks.bootstrapConfiguration.mockReturnValue(configuration);
    mocks.verifyBootstrapProof.mockResolvedValue({
      version: 1, email: configuration.email, expiresAt: 2_000_000_000, nonce: crypto.randomUUID(),
    });
    const { event } = callbackEvent({ cmail_bootstrap_proof: 'signed-proof' });

    await expect(GET(event as never)).rejects.toMatchObject({
      status: 303,
      location: '/?error=bootstrap_invalid',
    });
    expect(mocks.provisionBootstrapManager).not.toHaveBeenCalled();
  });
});

describe('sign-in country gate', () => {
  it('denies a non-bootstrap sign-in the gate refuses, records a travel request, and never creates a session', async () => {
    const db = fakeDb();
    mocks.findBoundUser.mockResolvedValue(returningUser);
    mocks.signInCountryGate.mockResolvedValue({ allowed: false });
    const { event } = callbackEvent({}, db);

    await expect(GET(event as never)).rejects.toMatchObject({
      status: 303,
      location: '/?error=country_pending',
    });

    expect(mocks.signInCountryGate).toHaveBeenCalledWith(db, expect.objectContaining({ signInCountries: [] }), {
      userId: returningUser.id,
      country: 'AU',
    });
    expect(mocks.recordTravelRequest).toHaveBeenCalledWith(db, expect.anything(), expect.objectContaining({
      user: returningUser,
      country: 'AU',
      appUrl: 'https://mail.example.com',
    }));
    const audited = JSON.stringify(mocks.audit.mock.calls);
    expect(audited).toContain('auth.sign_in_denied');
    expect(audited).toContain('country_blocked');
    expect(mocks.createSessionToken).not.toHaveBeenCalled();
  });

  it('exempts the bootstrap sign-in from the gate entirely, even when the gate would otherwise deny', async () => {
    mocks.signInCountryGate.mockResolvedValue({ allowed: false });
    const configuration = {
      email: 'admin@example.com', token: 'strong-token', sessionSecret: 'session-secret',
    };
    const manager = { ...returningUser, id: 'manager-1', email: configuration.email, role: 'manager' as const };
    mocks.fetchUserInfo.mockResolvedValue({
      subject: 'bootstrap-subject', email: configuration.email, name: 'First Manager',
      provider: 'google', emailVerified: true,
    });
    mocks.bootstrapConfiguration.mockReturnValue(configuration);
    mocks.verifyBootstrapProof.mockResolvedValue({
      version: 1, email: configuration.email, expiresAt: 2_000_000_000, nonce: crypto.randomUUID(),
    });
    mocks.provisionBootstrapManager.mockResolvedValue(manager);
    const db = fakeDb({ existingManager: null });
    const { event } = callbackEvent({ cmail_bootstrap_proof: 'signed-proof' }, db);

    const response = await GET(event as never) as Response;

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/mail');
    expect(mocks.signInCountryGate).not.toHaveBeenCalled();
    expect(mocks.recordTravelRequest).not.toHaveBeenCalled();
  });

  it('allows a returning sign-in when the gate approves', async () => {
    const db = fakeDb();
    mocks.findBoundUser.mockResolvedValue(returningUser);
    mocks.signInCountryGate.mockResolvedValue({ allowed: true });
    const { event } = callbackEvent({}, db);

    const response = await GET(event as never) as Response;
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/mail');
    expect(mocks.recordTravelRequest).not.toHaveBeenCalled();
  });
});

describe('Microsoft 365 sync first sign-in in the callback', () => {
  const syncedUser: User = { ...returningUser, id: 'synced-1', email: 'alice@example.com', status: 'pending', auth_provider: '' as never };

  it('signs in the synced account the verified ID token links to, with the ID token from the token exchange', async () => {
    mocks.exchangeCode.mockResolvedValue({ access_token: 'access-token', id_token: 'id-token-value', expires_in: 3600 });
    mocks.fetchUserInfo.mockResolvedValue({ subject: 'ms-sub', email: 'alice@example.com', name: 'Alice', provider: 'microsoft', emailVerified: true });
    mocks.bindSyncLinkedMicrosoftIdentity.mockResolvedValue({ status: 'bound', userId: 'synced-1' });
    const nonce = 'n'.repeat(43);
    const { event, cookies } = callbackEvent({ cmail_oauth_nonce_microsoft: nonce }, fakeDb({ enrolledUser: syncedUser }), 'microsoft');
    const response = await GET(event as never) as Response;
    // The nonce cookie is single use.
    expect(cookies.delete).toHaveBeenCalledWith('cmail_oauth_nonce_microsoft', { path: '/' });
    expect(mocks.bindSyncLinkedMicrosoftIdentity).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { idToken: 'id-token-value', subject: 'ms-sub', nonce, clientIp: '192.0.2.10' },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/mail');
    expect(mocks.createSessionToken).toHaveBeenCalledWith('synced-1', expect.anything(), expect.anything());
  });

  it('denies with the refusal code and signs no one in', async () => {
    mocks.bindSyncLinkedMicrosoftIdentity.mockResolvedValue({ status: 'refused', reason: 'manager', deny: 'identity_conflict', userId: 'synced-1' });
    const { event } = callbackEvent({}, fakeDb(), 'microsoft');
    await expect(GET(event as never)).rejects.toMatchObject({ status: 303, location: '/?error=identity_conflict' });
    expect(mocks.createSessionToken).not.toHaveBeenCalled();
    // One denial row, carrying the reason.
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event_type: 'auth.sign_in_denied',
      detail: 'Denied microsoft sign-in: identity_conflict (Microsoft 365 sync link: manager)',
    }));
  });

  it('changes nothing when not applicable (sync off): the old enrollment_required answer', async () => {
    const { event } = callbackEvent({}, fakeDb(), 'microsoft');
    await expect(GET(event as never)).rejects.toMatchObject({ location: '/?error=enrollment_required' });
    expect(mocks.createSessionToken).not.toHaveBeenCalled();
  });

  it('is never tried for Google, for an already bound identity, or with an invitation', async () => {
    const google = callbackEvent({}, fakeDb(), 'google');
    await expect(GET(google.event as never)).rejects.toMatchObject({ location: '/?error=enrollment_required' });
    mocks.findBoundUser.mockResolvedValue(returningUser);
    await GET(callbackEvent({}, fakeDb(), 'microsoft').event as never);
    mocks.findBoundUser.mockResolvedValue(null);
    mocks.findEnrollment.mockResolvedValue(null);
    mocks.enrollmentFailure.mockReturnValue('enrollment_required');
    await expect(GET(callbackEvent({ cmail_enrollment: 'invite' }, fakeDb(), 'microsoft').event as never)).rejects.toMatchObject({ status: 303 });
    expect(mocks.bindSyncLinkedMicrosoftIdentity).not.toHaveBeenCalled();
  });
});