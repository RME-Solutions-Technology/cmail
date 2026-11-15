import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessKeyStore, accessMode, normalizeTeamDomain, verifyAccessJwt, type FetchLike } from './access-jwt';

const TEAM = 'example.cloudflareaccess.com';
const ISSUER = `https://${TEAM}`;
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const AUD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const CONFIG = { issuer: ISSUER, certsUrl: CERTS_URL, audience: AUD };
const NOW_MS = Date.UTC(2026, 10, 15, 0, 0, 0);
const NOW = NOW_MS / 1000;

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array | string): string {
  const data = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: JsonWebKey & { kid?: string };

beforeAll(async () => {
  const params = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const pair = await crypto.subtle.generateKey(params, true, ['sign', 'verify']) as CryptoKeyPair;
  const other = await crypto.subtle.generateKey(params, true, ['sign', 'verify']) as CryptoKeyPair;
  signingKey = pair.privateKey;
  otherKey = other.privateKey;
  publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'kid-1', alg: 'RS256', use: 'sig' };
});

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: [AUD],
    email: 'Person@Example.com',
    exp: NOW + 600,
    iat: NOW - 10,
    nbf: NOW - 10,
    iss: ISSUER,
    type: 'app',
    identity_nonce: 'nonce-1',
    sub: '7335d417-61da-459d-899c-0a01c76a2f94',
    country: 'AU',
    ...overrides,
  };
}

async function sign(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: 'kid-1', typ: 'JWT' },
  key: CryptoKey = signingKey,
): Promise<string> {
  const input = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(input)));
  return `${input}.${base64Url(signature)}`;
}

function storeWith(keys: unknown[] = [publicJwk]): { store: AccessKeyStore; fetcher: ReturnType<typeof vi.fn> } {
  const fetcher = vi.fn(async () => Response.json({ keys }));
  return { store: new AccessKeyStore(fetcher as unknown as FetchLike), fetcher };
}

async function verify(token: string | null, store = storeWith().store, nowMs = NOW_MS) {
  return verifyAccessJwt(token, CONFIG, { keyStore: store, nowMs });
}

describe('accessMode', () => {
  it('is off only when both values are unset', () => {
    expect(accessMode({})).toEqual({ mode: 'off' });
    expect(accessMode({ ACCESS_TEAM_DOMAIN: ' ', ACCESS_AUD: '' })).toEqual({ mode: 'off' });
  });

  it('fails closed when only one value is set or a value is invalid', () => {
    expect(accessMode({ ACCESS_TEAM_DOMAIN: TEAM }).mode).toBe('misconfigured');
    expect(accessMode({ ACCESS_AUD: AUD }).mode).toBe('misconfigured');
    expect(accessMode({ ACCESS_TEAM_DOMAIN: 'attacker.example', ACCESS_AUD: AUD }).mode).toBe('misconfigured');
    expect(accessMode({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: 'short' }).mode).toBe('misconfigured');
  });

  it('builds the issuer and certs URL from the team domain', () => {
    const mode = accessMode({ ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, ACCESS_AUD: AUD, ACCESS_AUTO_PROVISION: 'TRUE' });
    expect(mode).toEqual({ mode: 'on', config: { issuer: ISSUER, certsUrl: CERTS_URL, audience: AUD, autoProvision: true } });
    const noProvision = accessMode({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_AUTO_PROVISION: 'yes' });
    expect(noProvision.mode === 'on' && noProvision.config.autoProvision).toBe(false);
  });

  it('accepts only cloudflareaccess.com team hosts', () => {
    expect(normalizeTeamDomain('Example.CloudflareAccess.com')).toBe(TEAM);
    expect(normalizeTeamDomain('http://example.cloudflareaccess.com')).toBeNull();
    expect(normalizeTeamDomain('example.cloudflareaccess.com.attacker.test')).toBeNull();
    expect(normalizeTeamDomain('a.b.cloudflareaccess.com')).toBeNull();
  });
});

describe('verifyAccessJwt', () => {
  it('accepts a valid token and returns the sub and normalised email', async () => {
    const identity = await verify(await sign(claims()));
    expect(identity).toEqual({ subject: '7335d417-61da-459d-899c-0a01c76a2f94', email: 'person@example.com' });
  });

  it('accepts a string aud and a token with no nbf or iat', async () => {
    const payload = claims({ aud: AUD });
    delete payload.nbf;
    delete payload.iat;
    expect(await verify(await sign(payload))).not.toBeNull();
  });

  it('rejects a missing or malformed token', async () => {
    expect(await verify(null)).toBeNull();
    expect(await verify('')).toBeNull();
    expect(await verify('a.b')).toBeNull();
    expect(await verify('a..c')).toBeNull();
    expect(await verify('x'.repeat(9000))).toBeNull();
    expect(await verify('!!!.@@@.###')).toBeNull();
  });

  it('rejects a bad signature', async () => {
    const token = await sign(claims());
    const [header, , signature] = token.split('.');
    const forgedPayload = base64Url(JSON.stringify(claims({ sub: 'someone-else' })));
    expect(await verify(`${header}.${forgedPayload}.${signature}`)).toBeNull();
    expect(await verify(await sign(claims(), undefined, otherKey))).toBeNull();
  });

  it('rejects the wrong audience', async () => {
    expect(await verify(await sign(claims({ aud: ['other-application-aud-tag-0000'] })))).toBeNull();
    expect(await verify(await sign(claims({ aud: [] })))).toBeNull();
    const payload = claims();
    delete payload.aud;
    expect(await verify(await sign(payload))).toBeNull();
  });

  it('rejects the wrong issuer', async () => {
    expect(await verify(await sign(claims({ iss: 'https://other.cloudflareaccess.com' })))).toBeNull();
    expect(await verify(await sign(claims({ iss: `${ISSUER}/` })))).toBeNull();
  });

  it('rejects an expired token beyond the skew, and accepts within it', async () => {
    expect(await verify(await sign(claims({ exp: NOW - 61 })))).toBeNull();
    expect(await verify(await sign(claims({ exp: NOW - 30 })))).not.toBeNull();
    const payload = claims();
    delete payload.exp;
    expect(await verify(await sign(payload))).toBeNull();
    expect(await verify(await sign(claims({ exp: String(NOW + 600) })))).toBeNull();
  });

  it('rejects a token that is not yet valid', async () => {
    expect(await verify(await sign(claims({ nbf: NOW + 120 })))).toBeNull();
    expect(await verify(await sign(claims({ iat: NOW + 120 })))).toBeNull();
    expect(await verify(await sign(claims({ nbf: NOW + 30 })))).not.toBeNull();
  });

  it('rejects alg none', async () => {
    const unsigned = `${base64Url(JSON.stringify({ alg: 'none', kid: 'kid-1' }))}.${base64Url(JSON.stringify(claims()))}.`;
    expect(await verify(unsigned)).toBeNull();
    const withJunk = `${base64Url(JSON.stringify({ alg: 'none', kid: 'kid-1' }))}.${base64Url(JSON.stringify(claims()))}.${base64Url('x')}`;
    expect(await verify(withJunk)).toBeNull();
  });

  it('rejects HS256 signed with the public key as the HMAC secret', async () => {
    const header = base64Url(JSON.stringify({ alg: 'HS256', kid: 'kid-1' }));
    const body = base64Url(JSON.stringify(claims()));
    const hmacKey = await crypto.subtle.importKey(
      'raw', encoder.encode(JSON.stringify(publicJwk)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(`${header}.${body}`)));
    expect(await verify(`${header}.${body}.${base64Url(mac)}`)).toBeNull();
  });

  it('rejects other algorithms, a missing kid, and embedded key headers', async () => {
    expect(await verify(await sign(claims(), { alg: 'RS512', kid: 'kid-1' }))).toBeNull();
    expect(await verify(await sign(claims(), { alg: 'rs256', kid: 'kid-1' }))).toBeNull();
    expect(await verify(await sign(claims(), { alg: 'RS256' }))).toBeNull();
    expect(await verify(await sign(claims(), { alg: 'RS256', kid: 'kid-1', jwk: publicJwk }))).toBeNull();
    expect(await verify(await sign(claims(), { alg: 'RS256', kid: 'kid-1', crit: ['exp'] }))).toBeNull();
  });

  it('rejects an unknown kid', async () => {
    expect(await verify(await sign(claims(), { alg: 'RS256', kid: 'kid-unknown' }))).toBeNull();
  });

  it('rejects service tokens and tokens without a usable sub or email', async () => {
    expect(await verify(await sign(claims({ sub: '', email: undefined, common_name: 'service.example' })))).toBeNull();
    expect(await verify(await sign(claims({ email: 'not-an-email' })))).toBeNull();
    expect(await verify(await sign(claims({ sub: 'x'.repeat(256) })))).toBeNull();
    expect(await verify(await sign(claims({ sub: 42 })))).toBeNull();
    expect(await verify(await sign(claims({ type: 'org' })))).toBeNull();
  });

  it('rejects everything when the certs endpoint fails or has no RS256 keys', async () => {
    const failing = new AccessKeyStore((async () => new Response('down', { status: 503 })) as FetchLike);
    expect(await verify(await sign(claims()), failing)).toBeNull();
    const wrongKeys = storeWith([{ ...publicJwk, alg: 'RS512' }, { kty: 'EC', kid: 'kid-1' }]).store;
    expect(await verify(await sign(claims()), wrongKeys)).toBeNull();
  });
});

describe('AccessKeyStore caching', () => {
  it('fetches the certs once and reuses them within the cache window', async () => {
    const { store, fetcher } = storeWith();
    const token = await sign(claims({ exp: NOW + 2 * 60 * 60 }));
    expect(await verify(token, store)).not.toBeNull();
    expect(await verify(token, store, NOW_MS + 30 * 60 * 1000)).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(CERTS_URL);
  });

  it('refetches after the cache window', async () => {
    const { store, fetcher } = storeWith();
    const token = await sign(claims({ exp: NOW + 3 * 60 * 60 }));
    await verify(token, store);
    await verify(token, store, NOW_MS + 61 * 60 * 1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('limits refetches for unknown kids', async () => {
    const { store, fetcher } = storeWith();
    await verify(await sign(claims()), store);
    const unknown = await sign(claims(), { alg: 'RS256', kid: 'kid-unknown' });
    await verify(unknown, store, NOW_MS + 1000);
    await verify(unknown, store, NOW_MS + 2000);
    await verify(unknown, store, NOW_MS + 3000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await verify(unknown, store, NOW_MS + 31_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps using cached keys for a while if a refresh fails, then stops', async () => {
    let up = true;
    const fetcher = vi.fn(async () => (up ? Response.json({ keys: [publicJwk] }) : new Response('down', { status: 503 })));
    const store = new AccessKeyStore(fetcher as unknown as FetchLike);
    const token = await sign(claims({ exp: NOW + 48 * 60 * 60 }));
    expect(await verify(token, store)).not.toBeNull();
    up = false;
    expect(await verify(token, store, NOW_MS + 2 * 60 * 60 * 1000)).not.toBeNull();
    expect(await verify(token, store, NOW_MS + 25 * 60 * 60 * 1000)).toBeNull();
  });
});
