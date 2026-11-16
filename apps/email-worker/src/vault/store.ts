// Vault storage in D1 (docs/secret-vault.md). Only the email Worker holds
// CMAIL_VAULT_KEY and only this module decrypts. Writes, retirements and
// rewraps each leave an audit_log row with the name, version and key id,
// never the value. Reads are env-first: a set env secret always wins.
import {
  VAULT_SECRETS,
  type VaultSecretName,
  type VaultSecretStatus,
  type VaultStatus,
} from '@cmail/shared/secret-vault';
import { VaultError, additionalData, loadKeyring, open, seal, type VaultKeyEnv, type VaultKeyring } from './crypto';

export interface VaultEnv extends VaultKeyEnv {
  DB: D1Database;
}

const AAD_CONTEXT = 'cmail-vault-secret';
/** Rows rewrapped per call, so one call stays well inside Worker limits. */
export const REWRAP_BATCH = 100;

interface VaultRow {
  id: string;
  name: string;
  version: number;
  purpose: string;
  kek_id: string;
  iv: string;
  ciphertext: string;
  status: string;
  not_after: number | null;
  created_at: number;
}

function rowAad(row: { id: string; name: string; version: number; purpose: string }): Uint8Array<ArrayBuffer> {
  return additionalData(AAD_CONTEXT, [row.id, row.name, row.version, row.purpose]);
}

function isMissingTable(caught: unknown): boolean {
  return caught instanceof Error && /no such table/i.test(caught.message);
}

function auditVault(db: D1Database, eventType: string, actorId: string | null, target: string, detail: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_log (event_id, timestamp, actor_id, actor_role, event_type, target, detail)
     VALUES (?, datetime('now'), ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), actorId, actorId ? 'manager' : 'system', eventType, target.slice(0, 64), detail.slice(0, 500));
}

/** The env value for a name, if set and non-blank. Never logged. */
export function envValue(env: object, name: VaultSecretName): string | null {
  const envName = VAULT_SECRETS[name].envName;
  if (!envName) return null;
  const value = (env as Record<string, unknown>)[envName];
  return typeof value === 'string' && value.trim() ? value : null;
}

async function activeRow(db: D1Database, name: VaultSecretName): Promise<VaultRow | null> {
  try {
    return await db.prepare(
      `SELECT id, name, version, purpose, kek_id, iv, ciphertext, status, not_after, created_at
       FROM secret_vault WHERE name = ? AND status = 'active'`,
    ).bind(name).first<VaultRow>();
  } catch (caught) {
    if (isMissingTable(caught)) return null;
    throw caught;
  }
}

export type ResolvedSecret = { source: 'env' | 'vault'; value: string; version: number | null };

/**
 * Env-first read: a set env secret wins and the vault is not touched. The
 * vault is read only when the env value is absent, i.e. for values the setup
 * wizard stored. Returns null when neither has a value; throws VaultError
 * (code only) when a stored value cannot be decrypted.
 */
export async function resolveSecret(env: VaultEnv, name: VaultSecretName, keyring?: VaultKeyring): Promise<ResolvedSecret | null> {
  const fromEnv = envValue(env, name);
  if (fromEnv !== null) return { source: 'env', value: fromEnv, version: null };
  const row = await activeRow(env.DB, name);
  if (!row) return null;
  if (row.purpose !== VAULT_SECRETS[name].purpose) throw new VaultError('decrypt_failed');
  const ring = keyring ?? await loadKeyring(env);
  const value = await open(ring, rowAad(row), { kekId: row.kek_id, iv: row.iv, ciphertext: row.ciphertext });
  return { source: 'vault', value, version: Number(row.version) };
}

export interface PutInput {
  name: VaultSecretName;
  value: string;
  actorId: string;
  notAfter?: number | null;
  now?: number;
}

/**
 * Stores a new version of a secret and retires the previous one, atomically,
 * with one audit row. Rotation of a value is simply another put.
 */
export async function putSecret(env: VaultEnv, input: PutInput, keyring?: VaultKeyring): Promise<{ version: number; kekId: string; shadowedByEnv: boolean }> {
  const spec = VAULT_SECRETS[input.name];
  const bytes = new TextEncoder().encode(input.value).length;
  if (!input.value.trim() || bytes > spec.maxBytes) throw new VaultError('invalid_value');
  const ring = keyring ?? await loadKeyring(env);
  if (!ring.current) throw new VaultError(ring.currentState === 'invalid' ? 'vault_key_invalid' : 'vault_key_missing');
  let latest: { v: number | null } | null;
  try {
    latest = await env.DB.prepare('SELECT MAX(version) AS v FROM secret_vault WHERE name = ?').bind(input.name).first<{ v: number | null }>();
  } catch (caught) {
    if (isMissingTable(caught)) throw new VaultError('not_installed');
    throw caught;
  }
  const version = Number(latest?.v ?? 0) + 1;
  const id = crypto.randomUUID();
  const now = input.now ?? Date.now();
  const sealed = await seal(ring, rowAad({ id, name: input.name, version, purpose: spec.purpose }), input.value);
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE secret_vault SET status = 'retired', retired_at = ? WHERE name = ? AND status = 'active'`).bind(now, input.name),
      env.DB.prepare(
        `INSERT INTO secret_vault (id, name, version, purpose, kek_id, iv, ciphertext, status, not_after, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      ).bind(id, input.name, version, spec.purpose, sealed.kekId, sealed.iv, sealed.ciphertext, input.notAfter ?? null, now, input.actorId),
      auditVault(env.DB, 'vault.secret_written', input.actorId, input.name, `Stored version ${version} of ${input.name} under key ${sealed.kekId}${version > 1 ? `; version ${version - 1} retired` : ''}`),
    ]);
  } catch (caught) {
    // A concurrent put took the same version number (UNIQUE name, version).
    if (caught instanceof Error && /UNIQUE|constraint/i.test(caught.message)) throw new VaultError('write_conflict');
    throw caught;
  }
  return { version, kekId: sealed.kekId, shadowedByEnv: envValue(env, input.name) !== null };
}

/** Retires the active version (wizard rollback). Rows are kept, never deleted here. */
export async function retireSecret(env: VaultEnv, name: VaultSecretName, actorId: string, now = Date.now()): Promise<{ retired: number }> {
  const row = await activeRow(env.DB, name);
  if (!row) return { retired: 0 };
  const [result] = await env.DB.batch([
    env.DB.prepare(`UPDATE secret_vault SET status = 'retired', retired_at = ? WHERE id = ? AND status = 'active'`).bind(now, row.id),
    auditVault(env.DB, 'vault.secret_retired', actorId, name, `Retired version ${row.version} of ${name}`),
  ]);
  return { retired: Number(result?.meta?.changes ?? 0) };
}

/**
 * Re-encrypts every row that is not under the current key (key rotation:
 * set the new CMAIL_VAULT_KEY, move the old one to CMAIL_VAULT_KEY_PREVIOUS,
 * call rewrap until `remaining` is 0, then remove the previous key). Each
 * update is guarded by the old kek_id and iv, so a concurrent write wins.
 */
export async function rewrapVault(env: VaultEnv, actorId: string, keyring?: VaultKeyring, now = Date.now()): Promise<{ rewrapped: number; unreadable: number; remaining: number; kekId: string }> {
  const ring = keyring ?? await loadKeyring(env);
  if (!ring.current) throw new VaultError(ring.currentState === 'invalid' ? 'vault_key_invalid' : 'vault_key_missing');
  const current = ring.current.id;
  // Only rows under the previous key can be rewrapped; rows under any other
  // key are counted as unreadable and left untouched, so they can never fill
  // the batch and starve the readable ones.
  const previous = ring.previous?.id ?? null;
  let rows: VaultRow[] = [];
  try {
    if (previous) {
      rows = (await env.DB.prepare(
        `SELECT id, name, version, purpose, kek_id, iv, ciphertext, status, not_after, created_at
         FROM secret_vault WHERE kek_id = ? ORDER BY created_at LIMIT ?`,
      ).bind(previous, REWRAP_BATCH).all<VaultRow>()).results;
    }
  } catch (caught) {
    if (isMissingTable(caught)) throw new VaultError('not_installed');
    throw caught;
  }
  let rewrapped = 0;
  let unreadable = 0;
  for (const row of rows) {
    const aad = rowAad(row);
    let value: string;
    try {
      value = await open(ring, aad, { kekId: row.kek_id, iv: row.iv, ciphertext: row.ciphertext });
    } catch (caught) {
      if (caught instanceof VaultError) {
        unreadable += 1;
        continue;
      }
      throw caught;
    }
    const sealed = await seal(ring, aad, value);
    const result = await env.DB.prepare(
      `UPDATE secret_vault SET kek_id = ?, iv = ?, ciphertext = ?, rewrapped_at = ? WHERE id = ? AND kek_id = ? AND iv = ?`,
    ).bind(sealed.kekId, sealed.iv, sealed.ciphertext, now, row.id, row.kek_id, row.iv).run();
    rewrapped += Number(result.meta?.changes ?? 0);
  }
  const left = await env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN kek_id != ? THEN 1 ELSE 0 END) AS orphaned FROM secret_vault WHERE kek_id != ?`,
  ).bind(previous ?? '', current).first<{ n: number; orphaned: number | null }>();
  const remaining = Number(left?.n ?? 0);
  unreadable += Number(left?.orphaned ?? 0);
  if (rows.length) {
    await (auditVault(env.DB, 'vault.rewrapped', actorId, 'secret_vault', `Re-encrypted ${rewrapped} vault rows under key ${current}; ${unreadable} unreadable; ${remaining} left`)).run();
  }
  return { rewrapped, unreadable, remaining, kekId: current };
}

/** Names, sources, versions and key ids only: never a value. */
export async function vaultStatus(env: VaultEnv): Promise<VaultStatus> {
  const ring = await loadKeyring(env);
  let rows: VaultRow[] = [];
  let installed = true;
  try {
    rows = (await env.DB.prepare(
      `SELECT id, name, version, purpose, kek_id, iv, ciphertext, status, not_after, created_at
       FROM secret_vault WHERE status = 'active'`,
    ).all<VaultRow>()).results;
  } catch (caught) {
    if (!isMissingTable(caught)) throw caught;
    installed = false;
  }
  const byName = new Map(rows.map((row) => [row.name, row]));
  const secrets: VaultSecretStatus[] = (Object.keys(VAULT_SECRETS) as VaultSecretName[]).map((name) => {
    const envSet = envValue(env, name) !== null;
    const row = byName.get(name);
    return {
      name,
      envSet,
      source: envSet ? 'env' : row ? 'vault' : 'none',
      version: row ? Number(row.version) : null,
      kekId: row?.kek_id ?? null,
      needsRewrap: Boolean(row && row.kek_id !== ring.current?.id),
      notAfter: row?.not_after == null ? null : Number(row.not_after),
      createdAt: row ? Number(row.created_at) : null,
    };
  });
  return {
    installed,
    keyState: ring.currentState,
    currentKekId: ring.current?.id ?? null,
    previousKeyState: ring.previousState,
    secrets,
  };
}
