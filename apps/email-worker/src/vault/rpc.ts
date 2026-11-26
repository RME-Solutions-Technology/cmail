// Private vault RPC for the web app (docs/secret-vault.md), reached only over
// the EMAIL_SERVICE service binding (the caller in index.ts already refuses
// every public hostname). The binding is the trust boundary: the Worker cannot
// see the browser session, so the web route that calls it (setup wizard,
// PR 2+) must itself require a signed-in manager session and a CSRF check. Only the allow-listed operations exist; there is no
// operation that returns a value. Every write names a cMail user id that must
// be an active manager, checked here again in D1. Responses and logs carry
// codes, names, versions and key ids only.
import {
  isVaultRpcOperation,
  isVaultSecretName,
  type VaultErrorCode,
  type VaultRpcOperation,
} from '@stanchion/shared/secret-vault';
import { VaultError } from './crypto';
import { auditVaultRefusal, putSecret, retireSecret, rewrapVault, vaultStatus, type VaultEnv } from './store';

const PREFIX = '/internal/vault/';
const MAX_BODY_BYTES = 64 * 1024;
const ACTOR_ID = /^[A-Za-z0-9_-]{1,64}$/;
const METHOD: Record<VaultRpcOperation, 'GET' | 'POST'> = { status: 'GET', put: 'POST', retire: 'POST', rewrap: 'POST' };

const STATUS_FOR: Record<VaultErrorCode, number> = {
  vault_key_missing: 503,
  vault_key_invalid: 503,
  key_unavailable: 503,
  decrypt_failed: 503,
  not_installed: 409,
  unknown_name: 400,
  invalid_value: 400,
  invalid_request: 400,
  write_conflict: 409,
};

function fail(code: VaultErrorCode): Response {
  return Response.json({ ok: false, error: code }, { status: STATUS_FOR[code] });
}

export function isVaultRpcPath(pathname: string): boolean {
  return pathname.startsWith(PREFIX);
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  let raw: ArrayBuffer;
  try {
    raw = await request.arrayBuffer();
  } catch {
    return null;
  }
  if (raw.byteLength > MAX_BODY_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function isActiveManager(db: D1Database, actorId: unknown): Promise<boolean> {
  if (typeof actorId !== 'string' || !ACTOR_ID.test(actorId)) return false;
  const row = await db.prepare(`SELECT 1 AS ok FROM users WHERE id = ? AND role = 'manager' AND status = 'active'`).bind(actorId).first<{ ok: number }>();
  return Boolean(row);
}

export async function handleVaultRpc(request: Request, env: VaultEnv): Promise<Response> {
  const url = new URL(request.url);
  const operation = url.pathname.slice(PREFIX.length);
  if (!isVaultRpcOperation(operation) || request.method !== METHOD[operation] || url.search) {
    return new Response('Not found', { status: 404 });
  }
  try {
    if (operation === 'status') return Response.json({ ok: true, status: await vaultStatus(env) });
    const body = await readBody(request);
    if (!body) return fail('invalid_request');
    if (!(await isActiveManager(env.DB, body.actorId))) {
      // Code only: never the supplied actor id, name or value.
      console.warn('Vault RPC refused', { operation, code: 'not_manager' });
      await auditVaultRefusal(env.DB, operation, 'not_manager');
      return fail('invalid_request');
    }
    const actorId = body.actorId as string;
    if (operation === 'rewrap') return Response.json({ ok: true, ...(await rewrapVault(env, actorId)) });
    if (!isVaultSecretName(body.name)) return fail('unknown_name');
    if (operation === 'retire') return Response.json({ ok: true, ...(await retireSecret(env, body.name, actorId)) });
    // put
    if (typeof body.value !== 'string') return fail('invalid_value');
    const notAfter = body.notAfter;
    if (notAfter !== undefined && notAfter !== null && !(typeof notAfter === 'number' && Number.isSafeInteger(notAfter) && notAfter > 0)) {
      return fail('invalid_request');
    }
    const result = await putSecret(env, { name: body.name, value: body.value, actorId, notAfter: notAfter ?? null });
    return Response.json({ ok: true, name: body.name, ...result });
  } catch (caught) {
    if (caught instanceof VaultError) {
      console.warn('Vault RPC refused', { operation, code: caught.code });
      return fail(caught.code);
    }
    // Error name only: a D1 message could quote bound parameters.
    console.error('Vault RPC failed', { operation, error: caught instanceof Error ? caught.name : 'UnknownError' });
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
