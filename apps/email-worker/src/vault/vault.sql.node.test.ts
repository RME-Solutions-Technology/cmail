import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../index';
import { migratedDatabase } from '../testing/sqlite-d1';
import { VaultError, additionalData, decodeKeyMaterial, loadKeyring, open, seal } from './crypto';
import { putSecret, resolveSecret, retireSecret, rewrapVault, vaultStatus } from './store';

// Test-only keys: 32 fixed bytes each, base64. Never real key material.
const KEY_A = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const SECRET = 'test-vault-value-7f3a9c';
const OTHER = 'test-vault-other-41d2e8';
const MANAGER = 'user-manager-1';
const STANDARD = 'user-standard-1';
const RPC = 'https://cmail-email-worker.internal/internal/vault/';

function setup(env: Record<string, unknown> = {}) {
  const { d1, sqlite } = migratedDatabase();
  sqlite.exec(`INSERT INTO users (id, email, role, status) VALUES
    ('${MANAGER}', 'manager@example.test', 'manager', 'active'),
    ('${STANDARD}', 'person@example.test', 'standard', 'active')`);
  return { env: { DB: d1, CMAIL_VAULT_KEY: KEY_A, ...env } as { DB: D1Database; CMAIL_VAULT_KEY?: string; CMAIL_VAULT_KEY_PREVIOUS?: string } & Record<string, unknown>, sqlite };
}

function rpc(env: object, operation: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return worker.fetch(new Request(RPC + operation, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }), env as never);
}

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(JSON.stringify(args)); });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('vault crypto', () => {
  it('accepts exactly 32 bytes of base64 or base64url key material', () => {
    expect(decodeKeyMaterial(KEY_A)?.length).toBe(32);
    expect(decodeKeyMaterial(KEY_A.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))?.length).toBe(32);
    expect(decodeKeyMaterial(btoa('short'))).toBeNull();
    expect(decodeKeyMaterial('not base64 !!')).toBeNull();
  });

  it('round-trips, with a fresh nonce each time and a stable versioned key id', async () => {
    const ring = await loadKeyring({ CMAIL_VAULT_KEY: KEY_A });
    const aad = additionalData('test', ['row-1', 'name', 1, 'purpose']);
    const one = await seal(ring, aad, SECRET);
    const two = await seal(ring, aad, SECRET);
    expect(one.iv).not.toBe(two.iv);
    expect(one.ciphertext).not.toContain(SECRET);
    expect(one.kekId).toMatch(/^v1-[0-9a-f]{16}$/);
    expect((await loadKeyring({ CMAIL_VAULT_KEY: KEY_A })).current?.id).toBe(one.kekId);
    expect((await loadKeyring({ CMAIL_VAULT_KEY: KEY_B })).current?.id).not.toBe(one.kekId);
    expect(await open(ring, aad, one)).toBe(SECRET);
  });

  it('refuses a ciphertext under different AAD, a flipped bit, or the wrong key', async () => {
    const ring = await loadKeyring({ CMAIL_VAULT_KEY: KEY_A });
    const sealed = await seal(ring, additionalData('test', ['row-1', 'name', 1, 'purpose']), SECRET);
    await expect(open(ring, additionalData('test', ['row-2', 'name', 1, 'purpose']), sealed)).rejects.toMatchObject({ code: 'decrypt_failed' });
    await expect(open(ring, additionalData('test', ['row-1', 'name', 2, 'purpose']), sealed)).rejects.toMatchObject({ code: 'decrypt_failed' });
    await expect(open(ring, additionalData('test', ['row-1', 'name', 1, 'other']), sealed)).rejects.toMatchObject({ code: 'decrypt_failed' });
    const bytes = Uint8Array.from(atob(sealed.ciphertext), (c) => c.charCodeAt(0));
    bytes[0] ^= 1;
    const flipped = { ...sealed, ciphertext: btoa(String.fromCharCode(...bytes)) };
    await expect(open(ring, additionalData('test', ['row-1', 'name', 1, 'purpose']), flipped)).rejects.toMatchObject({ code: 'decrypt_failed' });
    // Another key: its id does not match, so it is not even tried.
    const other = await loadKeyring({ CMAIL_VAULT_KEY: KEY_B });
    await expect(open(other, additionalData('test', ['row-1', 'name', 1, 'purpose']), sealed)).rejects.toMatchObject({ code: 'key_unavailable' });
    // Another key presented under the right id still fails authentication.
    await expect(open(other, additionalData('test', ['row-1', 'name', 1, 'purpose']), { ...sealed, kekId: other.current!.id })).rejects.toMatchObject({ code: 'decrypt_failed' });
    await expect(open(await loadKeyring({}), additionalData('test', ['row-1']), sealed)).rejects.toMatchObject({ code: 'vault_key_missing' });
  });

  it('refuses AAD parts that could be ambiguous', () => {
    expect(() => additionalData('test', ['a\nb'])).toThrow(VaultError);
  });
});

describe('vault store', () => {
  it('stores ciphertext only and reads it back when no env secret is set', async () => {
    const { env, sqlite } = setup();
    const put = await putSecret(env, { name: 'm365.sync.client_secret', value: SECRET, actorId: MANAGER });
    expect(put).toMatchObject({ version: 1, shadowedByEnv: false });
    const dump = JSON.stringify(sqlite.prepare('SELECT * FROM secret_vault').all());
    expect(dump).not.toContain(SECRET);
    expect(await resolveSecret(env, 'm365.sync.client_secret')).toEqual({ source: 'vault', value: SECRET, version: 1 });
  });

  it('is env-first: a set env secret wins and the vault is not read', async () => {
    const { env } = setup();
    await putSecret(env, { name: 'm365.sync.client_secret', value: SECRET, actorId: MANAGER });
    const withEnv = { ...env, M365_CLIENT_SECRET: OTHER };
    const prepare = vi.spyOn(withEnv.DB, 'prepare');
    expect(await resolveSecret(withEnv, 'm365.sync.client_secret')).toEqual({ source: 'env', value: OTHER, version: null });
    expect(prepare).not.toHaveBeenCalled();
    // Blank env values do not count as set.
    expect((await resolveSecret({ ...env, M365_CLIENT_SECRET: '  ' } as typeof env, 'm365.sync.client_secret'))?.source).toBe('vault');
    // Nothing anywhere, and no migration: no value, no error.
    expect(await resolveSecret({ DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1_ERROR: no such table: secret_vault'); } }) }) } as never }, 'm365.sync.client_secret')).toBeNull();
    const status = await vaultStatus(withEnv);
    expect(status.secrets.find((item) => item.name === 'm365.sync.client_secret')).toMatchObject({ envSet: true, source: 'env', version: 1 });
  });

  it('cannot be fooled by swapping ciphertext between rows', async () => {
    const { env, sqlite } = setup();
    await putSecret(env, { name: 'm365.sync.client_secret', value: SECRET, actorId: MANAGER });
    await putSecret(env, { name: 'm365.copyback.client_secret', value: OTHER, actorId: MANAGER });
    // Same purpose, different rows: copy one row's iv + ciphertext over the other.
    sqlite.exec(`UPDATE secret_vault SET iv = (SELECT iv FROM secret_vault WHERE name = 'm365.copyback.client_secret'),
      ciphertext = (SELECT ciphertext FROM secret_vault WHERE name = 'm365.copyback.client_secret')
      WHERE name = 'm365.sync.client_secret'`);
    await expect(resolveSecret(env, 'm365.sync.client_secret')).rejects.toMatchObject({ code: 'decrypt_failed' });
    // A version or purpose edit is caught the same way.
    sqlite.exec(`UPDATE secret_vault SET version = 7 WHERE name = 'm365.copyback.client_secret'`);
    await expect(resolveSecret(env, 'm365.copyback.client_secret')).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it('fails closed with the wrong key or no key', async () => {
    const { env } = setup();
    await putSecret(env, { name: 'm365.journal.address', value: 'journal-test@standby.example.test', actorId: MANAGER });
    await expect(resolveSecret({ ...env, CMAIL_VAULT_KEY: KEY_B }, 'm365.journal.address')).rejects.toMatchObject({ code: 'key_unavailable' });
    await expect(resolveSecret({ ...env, CMAIL_VAULT_KEY: undefined }, 'm365.journal.address')).rejects.toMatchObject({ code: 'vault_key_missing' });
    await expect(resolveSecret({ ...env, CMAIL_VAULT_KEY: 'too-short' }, 'm365.journal.address')).rejects.toMatchObject({ code: 'vault_key_invalid' });
    await expect(putSecret({ ...env, CMAIL_VAULT_KEY: undefined }, { name: 'm365.journal.address', value: SECRET, actorId: MANAGER })).rejects.toMatchObject({ code: 'vault_key_missing' });
  });

  it('versions values: a new put retires the old one, retire leaves none active', async () => {
    const { env, sqlite } = setup();
    await putSecret(env, { name: 'entra.sync.private_key', value: SECRET, actorId: MANAGER, notAfter: 1_900_000_000_000 });
    const second = await putSecret(env, { name: 'entra.sync.private_key', value: OTHER, actorId: MANAGER });
    expect(second.version).toBe(2);
    expect(await resolveSecret(env, 'entra.sync.private_key')).toEqual({ source: 'vault', value: OTHER, version: 2 });
    expect(sqlite.prepare(`SELECT version, status FROM secret_vault ORDER BY version`).all()).toEqual([
      { version: 1, status: 'retired' }, { version: 2, status: 'active' },
    ]);
    expect(await retireSecret(env, 'entra.sync.private_key', MANAGER)).toEqual({ retired: 1 });
    expect(await resolveSecret(env, 'entra.sync.private_key')).toBeNull();
    await expect(putSecret(env, { name: 'm365.journal.address', value: 'x'.repeat(321), actorId: MANAGER })).rejects.toMatchObject({ code: 'invalid_value' });
    await expect(putSecret(env, { name: 'm365.journal.address', value: '   ', actorId: MANAGER })).rejects.toMatchObject({ code: 'invalid_value' });
  });

  it('rotates the vault key: rewrap moves every row to the new key, then the old key can go', async () => {
    const { env, sqlite } = setup();
    await putSecret(env, { name: 'm365.sync.client_secret', value: SECRET, actorId: MANAGER });
    await putSecret(env, { name: 'm365.sync.client_secret', value: OTHER, actorId: MANAGER });
    const oldId = (await loadKeyring({ CMAIL_VAULT_KEY: KEY_A })).current!.id;
    const rotating = { ...env, CMAIL_VAULT_KEY: KEY_B, CMAIL_VAULT_KEY_PREVIOUS: KEY_A };
    // Readable during rotation through the previous key.
    expect((await resolveSecret(rotating, 'm365.sync.client_secret'))?.value).toBe(OTHER);
    expect((await vaultStatus(rotating)).secrets.find((item) => item.name === 'm365.sync.client_secret')?.needsRewrap).toBe(true);
    const result = await rewrapVault(rotating, MANAGER);
    expect(result).toMatchObject({ rewrapped: 2, unreadable: 0, remaining: 0 });
    expect(result.kekId).not.toBe(oldId);
    const after = { ...env, CMAIL_VAULT_KEY: KEY_B };
    expect((await resolveSecret(after, 'm365.sync.client_secret'))?.value).toBe(OTHER);
    await expect(resolveSecret(env, 'm365.sync.client_secret')).rejects.toMatchObject({ code: 'key_unavailable' });
    // Without the previous key, old rows are counted as unreadable, never dropped.
    sqlite.exec(`UPDATE secret_vault SET kek_id = 'v1-0000000000000000' WHERE version = 1`);
    expect(await rewrapVault(after, MANAGER)).toMatchObject({ rewrapped: 0, unreadable: 1, remaining: 0 });
    expect(Number((sqlite.prepare('SELECT COUNT(*) AS n FROM secret_vault').get() as { n: number }).n)).toBe(2);
  });

  it('audits writes, retirements and rewraps without values', async () => {
    const { env, sqlite } = setup();
    await putSecret(env, { name: 'm365.perms.cert_password', value: SECRET, actorId: MANAGER });
    await retireSecret(env, 'm365.perms.cert_password', MANAGER);
    await putSecret(env, { name: 'm365.perms.cert_password', value: OTHER, actorId: MANAGER });
    await rewrapVault({ ...env, CMAIL_VAULT_KEY: KEY_B, CMAIL_VAULT_KEY_PREVIOUS: KEY_A }, MANAGER);
    const rows = sqlite.prepare(`SELECT actor_id, actor_role, event_type, target, detail FROM audit_log WHERE event_type LIKE 'vault.%' ORDER BY rowid`).all() as Array<Record<string, string>>;
    expect(rows.map((row) => row.event_type)).toEqual(['vault.secret_written', 'vault.secret_retired', 'vault.secret_written', 'vault.rewrapped']);
    expect(rows.every((row) => row.actor_id === MANAGER && row.actor_role === 'manager')).toBe(true);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(OTHER);
  });
});

describe('vault RPC over the private binding', () => {
  it('allows only the listed operations and methods, on the internal hostname', async () => {
    const { env } = setup();
    for (const operation of ['get', 'read', 'decrypt', 'export', 'value', 'list', '', 'status/extra']) {
      expect((await rpc(env, operation)).status).toBe(404);
      expect((await rpc(env, operation, { actorId: MANAGER, name: 'm365.sync.client_secret' })).status).toBe(404);
    }
    expect((await rpc(env, 'status', { actorId: MANAGER })).status).toBe(404);
    expect((await rpc(env, 'put', undefined, 'GET')).status).toBe(404);
    expect((await rpc(env, 'status?name=x')).status).toBe(404);
    const publicHost = await worker.fetch(new Request('https://mail.example.test/internal/vault/status'), env as never);
    expect(publicHost.status).toBe(404);
  });

  it('puts, reports status and never returns or logs a value', async () => {
    const { env } = setup();
    const put = await rpc(env, 'put', { actorId: MANAGER, name: 'm365.sync.client_secret', value: SECRET });
    const putText = await put.text();
    expect(put.status).toBe(200);
    expect(JSON.parse(putText)).toMatchObject({ ok: true, name: 'm365.sync.client_secret', version: 1, shadowedByEnv: false });
    const status = await rpc(env, 'status');
    const statusText = await status.text();
    expect(JSON.parse(statusText).status).toMatchObject({ installed: true, keyState: 'ok', previousKeyState: 'missing' });
    for (const text of [putText, statusText, ...logged]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(KEY_A);
    }
  });

  it('refuses writes from anyone but an active manager, and unknown names', async () => {
    const { env } = setup();
    expect((await rpc(env, 'put', { actorId: STANDARD, name: 'm365.sync.client_secret', value: SECRET })).status).toBe(400);
    expect((await rpc(env, 'put', { actorId: 'nobody', name: 'm365.sync.client_secret', value: SECRET })).status).toBe(400);
    expect((await rpc(env, 'put', { name: 'm365.sync.client_secret', value: SECRET })).status).toBe(400);
    const unknown = await rpc(env, 'put', { actorId: MANAGER, name: 'SESSION_SECRET', value: SECRET });
    expect(await unknown.json()).toEqual({ ok: false, error: 'unknown_name' });
    expect((await rpc(env, 'put', { actorId: MANAGER, name: 'm365.sync.client_secret', value: 42 })).status).toBe(400);
    expect((await rpc(env, 'put', { actorId: MANAGER, name: 'm365.sync.client_secret', value: SECRET, notAfter: 'soon' })).status).toBe(400);
    const tooBig = await rpc(env, 'put', { actorId: MANAGER, name: 'm365.sync.client_secret', value: 'x'.repeat(70_000) });
    expect(tooBig.status).toBe(400);
  });

  it('reports a missing vault key by code only, and logs no value', async () => {
    const { env } = setup({ CMAIL_VAULT_KEY: undefined });
    const response = await rpc(env, 'put', { actorId: MANAGER, name: 'm365.sync.client_secret', value: SECRET });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'vault_key_missing' });
    expect(logged.join('\n')).not.toContain(SECRET);
    expect(logged.join('\n')).toContain('vault_key_missing');
  });

  it('retires and rewraps through the RPC', async () => {
    const { env } = setup();
    await rpc(env, 'put', { actorId: MANAGER, name: 'm365.sync.client_secret', value: SECRET });
    const rewrap = await rpc({ ...env, CMAIL_VAULT_KEY: KEY_B, CMAIL_VAULT_KEY_PREVIOUS: KEY_A }, 'rewrap', { actorId: MANAGER });
    expect(await rewrap.json()).toMatchObject({ ok: true, rewrapped: 1, remaining: 0 });
    const retire = await rpc(env, 'retire', { actorId: MANAGER, name: 'm365.sync.client_secret' });
    expect(await retire.json()).toEqual({ ok: true, retired: 1 });
    expect(logged.join('\n')).not.toContain(SECRET);
  });
});

describe('vault review follow-ups', () => {
  it('binds the instance: a row copied to another instance with the same key does not decrypt', async () => {
    const a = setup();
    const b = setup();
    await putSecret(a.env, { name: 'm365.sync.client_secret', value: SECRET, actorId: MANAGER });
    await putSecret(b.env, { name: 'm365.copyback.client_secret', value: OTHER, actorId: MANAGER });
    const row = a.sqlite.prepare(`SELECT * FROM secret_vault WHERE name = 'm365.sync.client_secret'`).get() as Record<string, string | number | null>;
    b.sqlite.prepare(`INSERT INTO secret_vault (id, name, version, purpose, kek_id, iv, ciphertext, status, not_after, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.name, row.version, row.purpose, row.kek_id, row.iv, row.ciphertext, row.status, row.not_after, row.created_at, row.created_by);
    await expect(resolveSecret(b.env, 'm365.sync.client_secret')).rejects.toMatchObject({ code: 'decrypt_failed' });
    // Without an instance row nothing decrypts either.
    a.sqlite.exec('DELETE FROM secret_vault_instance');
    await expect(resolveSecret(a.env, 'm365.sync.client_secret')).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it('refuses a nonce of the wrong length', async () => {
    const ring = await loadKeyring({ CMAIL_VAULT_KEY: KEY_A });
    const aad = additionalData('test', ['row-1']);
    const sealed = await seal(ring, aad, SECRET);
    await expect(open(ring, aad, { ...sealed, iv: btoa('short') })).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it('reports a lost race for the same version as write_conflict and keeps the winner', async () => {
    const { env } = setup();
    await putSecret(env, { name: 'm365.sync.client_secret', value: SECRET, actorId: MANAGER });
    // The loser read MAX(version) before the winner wrote: simulate that read.
    const real = env.DB.prepare.bind(env.DB);
    const racing = { ...env, DB: { ...env.DB, batch: env.DB.batch.bind(env.DB), prepare: (sql: string) => (/MAX\(version\)/.test(sql)
      ? { bind: () => ({ first: async () => ({ v: null }) }) } as unknown as D1PreparedStatement
      : real(sql)) } as unknown as D1Database };
    await expect(putSecret(racing, { name: 'm365.sync.client_secret', value: OTHER, actorId: MANAGER })).rejects.toMatchObject({ code: 'write_conflict' });
    expect(await resolveSecret(env, 'm365.sync.client_secret')).toEqual({ source: 'vault', value: SECRET, version: 1 });
  });

  it('says not_installed before migration 0035', async () => {
    const missing = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1_ERROR: no such table: secret_vault'); } }) }) } as unknown as D1Database;
    await expect(putSecret({ DB: missing, CMAIL_VAULT_KEY: KEY_A }, { name: 'm365.sync.client_secret', value: SECRET, actorId: MANAGER })).rejects.toMatchObject({ code: 'not_installed' });
    expect((await vaultStatus({ DB: { prepare: () => ({ all: async () => { throw new Error('D1_ERROR: no such table: secret_vault'); } }) } as unknown as D1Database, CMAIL_VAULT_KEY: KEY_A })).installed).toBe(false);
  });

  it('refuses a paused manager and audits the refusal by code only', async () => {
    const { env, sqlite } = setup();
    sqlite.exec(`INSERT INTO users (id, email, role, status) VALUES ('user-paused-1', 'paused@example.test', 'manager', 'paused')`);
    const response = await rpc(env, 'put', { actorId: 'user-paused-1', name: 'm365.sync.client_secret', value: SECRET });
    expect(response.status).toBe(400);
    const rows = sqlite.prepare(`SELECT actor_id, event_type, target, detail FROM audit_log WHERE event_type = 'vault.request_refused'`).all() as Array<Record<string, string | null>>;
    expect(rows).toEqual([{ actor_id: null, event_type: 'vault.request_refused', target: 'put', detail: 'Refused vault put: not_manager' }]);
    expect(logged.join('\n')).toContain('not_manager');
    expect(logged.join('\n')).not.toContain('user-paused-1');
    expect(logged.join('\n')).not.toContain(SECRET);
  });

  it('rewrap skips rows that fail under the previous key, so remaining reaches 0', async () => {
    const { env, sqlite } = setup();
    await putSecret(env, { name: 'm365.sync.client_secret', value: SECRET, actorId: MANAGER });
    await putSecret(env, { name: 'm365.copyback.client_secret', value: OTHER, actorId: MANAGER });
    // Corrupt one row's ciphertext (still under the previous key).
    sqlite.exec(`UPDATE secret_vault SET ciphertext = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE name = 'm365.sync.client_secret'`);
    const rotating = { ...env, CMAIL_VAULT_KEY: KEY_B, CMAIL_VAULT_KEY_PREVIOUS: KEY_A };
    expect(await rewrapVault(rotating, MANAGER)).toMatchObject({ rewrapped: 1, unreadable: 1, remaining: 0 });
    expect(await rewrapVault(rotating, MANAGER)).toMatchObject({ rewrapped: 0, unreadable: 1, remaining: 0 });
    expect(Number((sqlite.prepare('SELECT COUNT(*) AS n FROM secret_vault').get() as { n: number }).n)).toBe(2);
  });
});