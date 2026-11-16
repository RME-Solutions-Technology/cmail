import { describe, expect, it, vi } from 'vitest';
import { vaultPut, vaultRetire, vaultRewrap, vaultStatus } from './vault-client';

function service(response: Response | Error) {
  const fetch = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { fetch, binding: { fetch } as unknown as Fetcher };
}

describe('vault client (web app side)', () => {
  it('needs the private binding', async () => {
    expect(await vaultStatus(undefined)).toEqual({ ok: false, error: 'no_binding', status: 503 });
  });

  it('posts a put to the internal hostname and returns only metadata', async () => {
    const { fetch, binding } = service(Response.json({ ok: true, name: 'm365.sync.client_secret', version: 2, kekId: 'v1-0011223344556677', shadowedByEnv: false }));
    const result = await vaultPut(binding, { name: 'm365.sync.client_secret', value: 'test-value', actorId: 'user-1' });
    expect(result).toEqual({ ok: true, data: { name: 'm365.sync.client_secret', version: 2, kekId: 'v1-0011223344556677', shadowedByEnv: false } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cmail-email-worker.internal/internal/vault/put');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'm365.sync.client_secret', value: 'test-value', actorId: 'user-1', notAfter: null });
  });

  it('reads status with GET', async () => {
    const status = { installed: true, keyState: 'ok', currentKekId: 'v1-0011223344556677', previousKeyState: 'missing', secrets: [] };
    const { fetch, binding } = service(Response.json({ ok: true, status }));
    expect(await vaultStatus(binding)).toEqual({ ok: true, data: status });
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('GET');
  });

  it('passes through stable error codes only', async () => {
    expect(await vaultRetire(service(Response.json({ ok: false, error: 'unknown_name' }, { status: 400 })).binding, { name: 'm365.sync.client_secret', actorId: 'user-1' }))
      .toEqual({ ok: false, error: 'unknown_name', status: 400 });
    expect(await vaultRewrap(service(Response.json({ ok: false, error: 'Some <b>free</b> text' }, { status: 500 })).binding, { actorId: 'user-1' }))
      .toEqual({ ok: false, error: 'failed', status: 500 });
    expect(await vaultRewrap(service(new Error('network')).binding, { actorId: 'user-1' }))
      .toEqual({ ok: false, error: 'unreachable', status: 503 });
  });
});
