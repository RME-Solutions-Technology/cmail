import { describe, expect, it } from 'vitest';
import { COLLECT_DEADLINE_SECONDS, M365PermsCollector, runCollector, scriptEnv, type CollectorContainer } from './collector';

const env = {
  M365_TENANT_ID: '00000000-0000-0000-0000-000000000000',
  M365_EXO_APP_ID: '22222222-2222-2222-2222-222222222222',
  M365_EXO_ORGANIZATION: 'example.onmicrosoft.com',
  M365_EXO_CERT_PFX_B64: 'cGZ4',
  M365_EXO_CERT_PASSWORD: 'pw',
};

function stream(text: string): ReadableStream {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

function fakeContainer(script: { exit: number | 'hang'; files?: Record<string, string> }, options: { images?: Record<string, string> } = {}) {
  const log: Array<{ cmd: string[]; env?: Record<string, string> }> = [];
  let running = false;
  const starts: unknown[] = [];
  let destroyed = 0;
  const container: CollectorContainer = {
    get running() { return running; },
    images: options.images ?? { base: 'registry.example.test/collector@sha256:00' },
    start(opts) { starts.push(opts); running = true; },
    async destroy() { destroyed += 1; running = false; },
    async setInactivityTimeout() { /* no-op */ },
    async exec(cmd, opts) {
      log.push({ cmd, env: opts?.env });
      if (cmd[0] === 'pwsh') {
        if (script.exit === 'hang') return { exitCode: Promise.reject(new Error('aborted')), stdout: null };
        return { exitCode: Promise.resolve(script.exit), stdout: null };
      }
      const file = script.files?.[cmd[1]];
      return { exitCode: Promise.resolve(file === undefined ? 1 : 0), stdout: stream(file ?? '') };
    },
  };
  return { container, log, starts, destroyed: () => destroyed };
}

describe('collector container run', () => {
  it('starts the image with internet, runs the script with the certificate in that process only, and always destroys the container', async () => {
    const fake = fakeContainer({ exit: 0, files: { '/tmp/cmail-out/result.json': '{"ok":1}' } });
    expect(await runCollector(fake.container, env, '')).toEqual({ ok: true, snapshot: '{"ok":1}' });
    expect(fake.starts).toEqual([{ image: 'registry.example.test/collector@sha256:00', instance: 'standard-1', enableInternet: true, entrypoint: ['sleep', '1200'] }]);
    expect(JSON.stringify(fake.starts)).not.toContain('cGZ4');
    const run = fake.log.find((entry) => entry.cmd[0] === 'pwsh')!;
    expect(run.cmd).toEqual(['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', '/opt/cmail/collect.ps1']);
    expect(run.env).toMatchObject({ CMAIL_EXO_CERT_PFX_B64: 'cGZ4', CMAIL_DEADLINE_SECONDS: String(COLLECT_DEADLINE_SECONDS), POWERSHELL_TELEMETRY_OPTOUT: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' });
    expect(fake.destroyed()).toBeGreaterThanOrEqual(1);
  });

  it('returns the script error code when it fails', async () => {
    const fake = fakeContainer({ exit: 1, files: { '/tmp/cmail-out/error.json': '{"code":"exchange_role_missing"}' } });
    expect(await runCollector(fake.container, env, '')).toEqual({ ok: false, code: 'exchange_role_missing' });
    expect(fake.destroyed()).toBeGreaterThanOrEqual(1);
  });

  it('ignores an error code that is not a plain code', async () => {
    const fake = fakeContainer({ exit: 1, files: { '/tmp/cmail-out/error.json': '{"code":"<b>bad</b>"}' } });
    expect(await runCollector(fake.container, env, '')).toEqual({ ok: false, code: 'collector_failed' });
  });

  it('reports a timeout when the process is killed', async () => {
    const fake = fakeContainer({ exit: 'hang' });
    expect(await runCollector(fake.container, env, '')).toEqual({ ok: false, code: 'collector_timeout' });
    expect(fake.destroyed()).toBeGreaterThanOrEqual(1);
  });

  it('fails cleanly without a container or image', async () => {
    expect(await runCollector(undefined, env, '')).toEqual({ ok: false, code: 'no_container' });
    const fake = fakeContainer({ exit: 0 }, { images: {} });
    expect(await runCollector(fake.container, env, '')).toEqual({ ok: false, code: 'no_image' });
  });

  it('passes only a GUID cursor', () => {
    expect(scriptEnv(env, 'x; rm -rf /').CMAIL_START_AFTER).toBe('');
    expect(scriptEnv(env, '00000000-0000-0000-aaaa-000000000001').CMAIL_START_AFTER).toBe('00000000-0000-0000-aaaa-000000000001');
  });
});

describe('collector Durable Object', () => {
  function fakeState(container?: CollectorContainer) {
    const store = new Map<string, unknown>();
    let alarm: number | null = null;
    const storage = {
      async get(keyOrKeys: string | string[]) {
        if (Array.isArray(keyOrKeys)) return new Map(keyOrKeys.filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
        return store.get(keyOrKeys);
      },
      async put(keyOrEntries: string | Record<string, unknown>, value?: unknown) {
        if (typeof keyOrEntries === 'string') store.set(keyOrEntries, value);
        else for (const [k, v] of Object.entries(keyOrEntries)) store.set(k, v);
      },
      async delete(keyOrKeys: string | string[]) { for (const k of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) store.delete(k); },
      async setAlarm(at: number) { alarm = at; },
    };
    return { state: { storage, container } as unknown as DurableObjectState, alarm: () => alarm };
  }
  const switchDb = (enabled: boolean) => ({
    prepare: () => ({ bind: () => ({ all: async () => ({ results: enabled ? [{ key: 'm365_perms_enabled', value: 'true' }] : [] }) }) }),
  }) as unknown as D1Database;
  const begin = (object: M365PermsCollector, runId = 'round-1') => object.fetch(new Request('https://m365-perms-collector.internal/begin', { method: 'POST', body: JSON.stringify({ runId, cursor: '' }) }));
  const result = async (object: M365PermsCollector, runId = 'round-1') => {
    const response = await object.fetch(new Request(`https://m365-perms-collector.internal/result?runId=${runId}`));
    return response.headers.get('x-collector-status') === 'done' ? { status: 'done', text: await response.text() } : response.json();
  };

  it('starts nothing when the switch was turned off before the alarm ran', async () => {
    const fake = fakeContainer({ exit: 0, files: { '/tmp/cmail-out/result.json': '{}' } });
    const { state, alarm } = fakeState(fake.container);
    const object = new M365PermsCollector(state, { ...env, DB: switchDb(false) });
    expect((await begin(object)).status).toBe(202);
    expect(alarm()).not.toBeNull();
    await object.alarm();
    expect(fake.starts).toEqual([]);
    expect(fake.log).toEqual([]);
    expect(await result(object)).toEqual({ status: 'failed', code: 'switched_off' });
  });

  it('runs once when on, stores the snapshot in chunks and hands it back for that run id only', async () => {
    const fake = fakeContainer({ exit: 0, files: { '/tmp/cmail-out/result.json': '{"snapshot":true}' } });
    const { state } = fakeState(fake.container);
    const object = new M365PermsCollector(state, { ...env, DB: switchDb(true) });
    await begin(object);
    expect(await result(object)).toEqual({ status: 'running' });
    expect((await begin(object, 'round-2')).status).toBe(409);
    await object.alarm();
    expect(fake.starts).toHaveLength(1);
    expect(await result(object)).toEqual({ status: 'done', text: '{"snapshot":true}' });
    expect(await result(object, 'round-9')).toEqual({ status: 'unknown' });
  });
});