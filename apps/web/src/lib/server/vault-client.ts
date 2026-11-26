// Web-app side of the secret vault (docs/secret-vault.md). The web app never
// holds CMAIL_VAULT_KEY and can never read a stored value back: it can only
// ask the email Worker, over the private EMAIL_SERVICE binding, for status,
// to store a new version, to retire one, or to re-encrypt after a key change.
// The caller must already have checked that the user is a manager; the Worker
// checks it again. Values sent to `put` must never be logged or rendered.
import {
  VAULT_RPC_BASE,
  type VaultRpcOperation,
  type VaultSecretName,
  type VaultStatus,
} from '@stanchion/shared/secret-vault';

export type VaultCallResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

function isFetcher(value: unknown): value is Fetcher {
  return Boolean(value) && typeof (value as Fetcher).fetch === 'function';
}

const SAFE_ERROR = /^[a-z_]{1,32}$/;

async function call<T>(service: unknown, operation: VaultRpcOperation, body?: Record<string, unknown>): Promise<VaultCallResult<T>> {
  if (!isFetcher(service)) return { ok: false, error: 'no_binding', status: 503 };
  let response: Response;
  try {
    response = await service.fetch(VAULT_RPC_BASE + operation, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }
      : { method: 'GET', signal: AbortSignal.timeout(5_000) });
  } catch {
    return { ok: false, error: 'unreachable', status: 503 };
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = await response.json() as Record<string, unknown>;
  } catch {
    // Non-JSON answer: reported as a generic failure below.
  }
  if (!response.ok || parsed.ok !== true) {
    const error = typeof parsed.error === 'string' && SAFE_ERROR.test(parsed.error) ? parsed.error : 'failed';
    return { ok: false, error, status: response.status || 502 };
  }
  const data: Record<string, unknown> = { ...parsed };
  delete data.ok;
  return { ok: true, data: data as T };
}

export async function vaultStatus(service: unknown): Promise<VaultCallResult<VaultStatus>> {
  const result = await call<{ status: VaultStatus }>(service, 'status');
  return result.ok ? { ok: true, data: result.data.status } : result;
}

export function vaultPut(
  service: unknown,
  input: { name: VaultSecretName; value: string; actorId: string; notAfter?: number | null },
): Promise<VaultCallResult<{ name: VaultSecretName; version: number; kekId: string; shadowedByEnv: boolean }>> {
  return call(service, 'put', { name: input.name, value: input.value, actorId: input.actorId, notAfter: input.notAfter ?? null });
}

export function vaultRetire(service: unknown, input: { name: VaultSecretName; actorId: string }): Promise<VaultCallResult<{ retired: number }>> {
  return call(service, 'retire', { name: input.name, actorId: input.actorId });
}

export function vaultRewrap(service: unknown, input: { actorId: string }): Promise<VaultCallResult<{ rewrapped: number; unreadable: number; remaining: number; kekId: string }>> {
  return call(service, 'rewrap', { actorId: input.actorId });
}
