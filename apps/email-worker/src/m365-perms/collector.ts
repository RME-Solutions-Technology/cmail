// The collector: a Durable Object that owns one Cloudflare Container running
// container/m365-perms/collect.ps1 (PowerShell 7 + ExchangeOnlineManagement,
// read-only cmdlets only). docs/m365-mailbox-permissions.md, "Architecture".
//
// Cloudflare documents this pattern: a Worker cron reaches a Durable Object,
// which starts its container (https://developers.cloudflare.com/containers/examples/cron/),
// runs a process in it with exec() and reads its output
// (https://developers.cloudflare.com/containers/api/durable-object-container/).
//
// Flow: the email Worker's cron calls POST /begin with a run id. The object
// records the run and sets an alarm for now. The alarm (up to 15 minutes of
// wall time) starts the container, runs the script with the certificate in
// the process environment only, reads the snapshot file back, stores it in
// Durable Object storage and destroys the container. Later cron runs read it
// with GET /result. Nothing here writes to D1 or calls Microsoft itself.
//
// The class is a plain Durable Object (fetch + alarm, no RPC) so the Worker
// bundle needs no `cloudflare:workers` import.
import { loadM365PermsSwitch, type M365PermsEnv } from '@cmail/shared/m365-perms';
import { SNAPSHOT_MAX_BYTES } from './snapshot';

const COLLECTOR_NAME = 'm365-perms-collector';
const ORIGIN = 'https://m365-perms-collector.internal';
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z_]{1,48}$/;

/** The script stops taking new mailboxes after this many seconds and writes what it has. */
export const COLLECT_DEADLINE_SECONDS = 10 * 60;
/** The process is killed after this long (inside the 15-minute alarm limit). */
export const COLLECT_KILL_MS = 13 * 60 * 1000;
/** A run still marked running after this long is treated as failed. */
export const COLLECT_STALE_MS = 20 * 60 * 1000;
/**
 * Instance size. With the durable_object scheduling policy start() accepts
 * lite, standard-1..4 or a custom object, not 'basic'
 * (https://developers.cloudflare.com/containers/configuration/scheduling-policy/).
 * lite (256 MiB) is too small for PowerShell 7 + ExchangeOnlineManagement;
 * standard-1 is the smallest named size above it: 1/2 vCPU, 4 GiB, 8 GB.
 */
export const COLLECTOR_INSTANCE = 'standard-1';
const CHUNK_CHARS = 1_000_000;
const OUT_DIR = '/tmp/cmail-out';
const SCRIPT = '/opt/cmail/collect.ps1';

export interface RunRecord {
  runId: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  code: string;
  chunks: number;
  cursor: string;
}

/** The subset of the container API the collector uses (tests pass a fake). */
export interface CollectorContainer {
  readonly running: boolean;
  readonly images?: Record<string, string>;
  start(options: ContainerStartupOptions & { image?: string }): void;
  destroy(error?: unknown): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
  exec(cmd: string[], options?: ContainerExecOptions): Promise<{ exitCode: Promise<number>; stdout: ReadableStream | null }>;
}

/** Environment for the script: the certificate goes to this one process only. */
export function scriptEnv(env: M365PermsEnv, cursor: string): Record<string, string> {
  return {
    CMAIL_EXO_TENANT_ID: (env.M365_TENANT_ID ?? '').trim().toLowerCase(),
    CMAIL_EXO_APP_ID: (env.M365_EXO_APP_ID ?? '').trim().toLowerCase(),
    CMAIL_EXO_ORGANIZATION: (env.M365_EXO_ORGANIZATION ?? '').trim().toLowerCase(),
    CMAIL_EXO_CERT_PFX_B64: (env.M365_EXO_CERT_PFX_B64 ?? '').trim(),
    CMAIL_EXO_CERT_PASSWORD: env.M365_EXO_CERT_PASSWORD ?? '',
    CMAIL_START_AFTER: GUID.test(cursor) ? cursor : '',
    CMAIL_DEADLINE_SECONDS: String(COLLECT_DEADLINE_SECONDS),
    CMAIL_OUT_DIR: OUT_DIR,
    HOME: '/tmp',
    // exec() gets only PATH from the container start, so the image's opt-outs
    // are passed again here.
    POWERSHELL_TELEMETRY_OPTOUT: '1',
    POWERSHELL_UPDATECHECK: 'Off',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  };
}

async function readCapped(stream: ReadableStream | null, cap: number): Promise<string | null> {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
    total += bytes.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(bytes);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function readFile(container: CollectorContainer, path: string, cap: number): Promise<string | null> {
  const proc = await container.exec(['cat', path], { stdout: 'pipe', stderr: 'ignore', signal: AbortSignal.timeout(60_000) });
  const [text, code] = await Promise.all([readCapped(proc.stdout, cap), proc.exitCode]);
  return code === 0 ? text : null;
}

export type CollectOutcome = { ok: true; snapshot: string } | { ok: false; code: string };

/**
 * One collection: start the container, run the script, read its result,
 * always destroy the container. Never throws; failures come back as codes.
 */
export async function runCollector(container: CollectorContainer | undefined, env: M365PermsEnv, cursor: string): Promise<CollectOutcome> {
  if (!container) return { ok: false, code: 'no_container' };
  const image = container.images?.base;
  if (!image) return { ok: false, code: 'no_image' };
  try {
    if (container.running) await container.destroy();
    // Internet access is needed for login.microsoftonline.com and
    // outlook.office365.com. The image holds no secret; the certificate is
    // passed to the one exec'd process below, never to the container start.
    container.start({ image, instance: COLLECTOR_INSTANCE, enableInternet: true, entrypoint: ['sleep', '1200'] });
    await container.setInactivityTimeout(COLLECT_STALE_MS);
    const proc = await container.exec(
      ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', SCRIPT],
      { env: scriptEnv(env, cursor), stdout: 'ignore', stderr: 'ignore', signal: AbortSignal.timeout(COLLECT_KILL_MS) },
    );
    let exit: number;
    try {
      exit = await proc.exitCode;
    } catch {
      return { ok: false, code: 'collector_timeout' };
    }
    if (exit !== 0) {
      const error = await readFile(container, `${OUT_DIR}/error.json`, 4096).catch(() => null);
      let code = 'collector_failed';
      try {
        const parsed = error ? JSON.parse(error) as { code?: unknown } : null;
        if (typeof parsed?.code === 'string' && CODE.test(parsed.code)) code = parsed.code;
      } catch {
        // Keep the generic code.
      }
      return { ok: false, code };
    }
    const snapshot = await readFile(container, `${OUT_DIR}/result.json`, SNAPSHOT_MAX_BYTES);
    if (snapshot === null) return { ok: false, code: 'bad_snapshot' };
    return { ok: true, snapshot };
  } catch (caught) {
    console.error('Mailbox access collector failed', { error: caught instanceof Error ? caught.name : 'UnknownError' });
    return { ok: false, code: 'collector_failed' };
  } finally {
    await container.destroy().catch(() => undefined);
  }
}

/** The collector Durable Object. Bound as M365_PERMS_COLLECTOR. */
/** The Worker's own bindings, which the Durable Object shares. */
export interface CollectorEnv extends M365PermsEnv {
  DB?: D1Database;
}

export class M365PermsCollector implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: CollectorEnv) {}

  private async run(): Promise<RunRecord | null> {
    return (await this.state.storage.get<RunRecord>('run')) ?? null;
  }

  private async clearChunks(record: RunRecord | null): Promise<void> {
    if (!record?.chunks) return;
    await this.state.storage.delete(Array.from({ length: record.chunks }, (_, index) => `chunk:${index}`));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/begin') {
      let body: { runId?: unknown; cursor?: unknown };
      try {
        body = await request.json();
      } catch {
        return Response.json({ status: 'bad_request' }, { status: 400 });
      }
      const runId = typeof body.runId === 'string' && RUN_ID.test(body.runId) ? body.runId : '';
      const cursor = typeof body.cursor === 'string' && GUID.test(body.cursor) ? body.cursor : '';
      if (!runId) return Response.json({ status: 'bad_request' }, { status: 400 });
      const current = await this.run();
      if (current?.status === 'running' && Date.now() - current.startedAt < COLLECT_STALE_MS) {
        return Response.json({ status: current.runId === runId ? 'started' : 'busy' }, { status: current.runId === runId ? 202 : 409 });
      }
      await this.clearChunks(current);
      const record: RunRecord = { runId, status: 'running', startedAt: Date.now(), finishedAt: null, code: '', chunks: 0, cursor };
      await this.state.storage.put('run', record);
      await this.state.storage.setAlarm(Date.now());
      return Response.json({ status: 'started' }, { status: 202 });
    }
    if (request.method === 'GET' && url.pathname === '/result') {
      const runId = url.searchParams.get('runId') ?? '';
      const record = await this.run();
      if (!record || record.runId !== runId) return Response.json({ status: 'unknown' }, { status: 404 });
      if (record.status === 'running') {
        if (Date.now() - record.startedAt > COLLECT_STALE_MS) return Response.json({ status: 'failed', code: 'collector_timeout' });
        return Response.json({ status: 'running' });
      }
      if (record.status === 'failed') return Response.json({ status: 'failed', code: record.code || 'collector_failed' });
      const keys = Array.from({ length: record.chunks }, (_, index) => `chunk:${index}`);
      const stored = keys.length ? await this.state.storage.get<string>(keys) : new Map<string, string>();
      const parts: string[] = [];
      for (const k of keys) {
        const part = stored.get(k);
        if (typeof part !== 'string') return Response.json({ status: 'failed', code: 'snapshot_lost' });
        parts.push(part);
      }
      return new Response(parts.join(''), { headers: { 'content-type': 'application/json', 'x-collector-status': 'done' } });
    }
    if (request.method === 'POST' && url.pathname === '/discard') {
      const runId = url.searchParams.get('runId') ?? '';
      const record = await this.run();
      if (record && record.runId === runId && record.status !== 'running') {
        await this.clearChunks(record);
        await this.state.storage.delete('run');
      }
      return Response.json({ status: 'ok' });
    }
    return new Response('Not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const record = await this.run();
    if (!record || record.status !== 'running') return;
    // Switched off since the run was requested (or a retried alarm after it
    // was): no container, no Microsoft call.
    let enabled = false;
    try {
      enabled = this.env.DB ? (await loadM365PermsSwitch(this.env.DB)).enabled : false;
    } catch {
      enabled = false;
    }
    if (!enabled) {
      await this.state.storage.put('run', { ...record, status: 'failed', finishedAt: Date.now(), code: 'switched_off' });
      return;
    }
    const outcome = await runCollector(this.state.container as CollectorContainer | undefined, this.env, record.cursor);
    // Only finish the run this alarm started (a newer /begin may have replaced it).
    const latest = await this.run();
    if (!latest || latest.runId !== record.runId) return;
    if (!outcome.ok) {
      await this.state.storage.put('run', { ...latest, status: 'failed', finishedAt: Date.now(), code: outcome.code });
      return;
    }
    const chunks: Record<string, string> = {};
    let count = 0;
    for (let start = 0; start < outcome.snapshot.length; start += CHUNK_CHARS) {
      chunks[`chunk:${count}`] = outcome.snapshot.slice(start, start + CHUNK_CHARS);
      count += 1;
    }
    if (count) await this.state.storage.put(chunks);
    await this.state.storage.put('run', { ...latest, status: 'done', finishedAt: Date.now(), code: '', chunks: count });
  }
}

// ─── Worker side ─────────────────────────────────────────────────────────

export type CollectStatus =
  | { status: 'running' }
  | { status: 'done'; snapshot: string }
  | { status: 'failed'; code: string }
  | { status: 'unknown' };

function stub(namespace: DurableObjectNamespace): DurableObjectStub {
  return namespace.get(namespace.idFromName(COLLECTOR_NAME));
}

export async function beginCollect(namespace: DurableObjectNamespace, runId: string, cursor: string): Promise<'started' | 'busy'> {
  const response = await stub(namespace).fetch(`${ORIGIN}/begin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, cursor }),
  });
  const body = await response.json().catch(() => null) as { status?: unknown } | null;
  if (response.status === 202 && body?.status === 'started') return 'started';
  if (response.status === 409) return 'busy';
  throw new Error('collector_begin_failed');
}

export async function readCollect(namespace: DurableObjectNamespace, runId: string): Promise<CollectStatus> {
  const response = await stub(namespace).fetch(`${ORIGIN}/result?runId=${encodeURIComponent(runId)}`, { method: 'GET' });
  if (response.headers.get('x-collector-status') === 'done') {
    const text = await readCapped(response.body, SNAPSHOT_MAX_BYTES);
    return text === null ? { status: 'failed', code: 'bad_snapshot' } : { status: 'done', snapshot: text };
  }
  const body = await response.json().catch(() => null) as { status?: unknown; code?: unknown } | null;
  if (body?.status === 'running') return { status: 'running' };
  if (body?.status === 'failed') return { status: 'failed', code: typeof body.code === 'string' && CODE.test(body.code) ? body.code : 'collector_failed' };
  return { status: 'unknown' };
}

export async function discardCollect(namespace: DurableObjectNamespace, runId: string): Promise<void> {
  const response = await stub(namespace).fetch(`${ORIGIN}/discard?runId=${encodeURIComponent(runId)}`, { method: 'POST' });
  await response.body?.cancel().catch(() => undefined);
}
