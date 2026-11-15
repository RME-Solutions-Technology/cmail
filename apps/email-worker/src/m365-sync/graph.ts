// Minimal, read-only Microsoft Graph client for the Microsoft 365 mailbox
// sync. It does three things only: get an app-only token (client
// credentials), GET a users/delta page, and POST a JSON $batch of
// checkMemberGroups calls. It never sends a write to Microsoft.
//
// Safety rules:
// - Only https://graph.microsoft.com/v1.0/ URLs are ever fetched with the
//   token, including @odata.nextLink / @odata.deltaLink values from a
//   response, so a bad response cannot point the token at another host.
// - 429, 503 and 504 honour Retry-After (Graph throttling guidance). A short
//   wait is retried in place; a longer one stops the run and the next cron
//   resumes from the saved page.
// - 410 Gone, or a syncStateNotFound / resyncRequired error code, means the
//   delta token is no longer usable: the caller restarts with a full
//   reconciliation (delta query overview, "Synchronization reset").
// - Errors carry a short code, never response bodies, tokens or addresses.

export const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0/';
const LOGIN_HOST = 'https://login.microsoftonline.com/';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
/** Waits at or under this are retried in place; longer ones end the run. */
const MAX_INLINE_WAIT_SECONDS = 5;
const MAX_INLINE_RETRIES = 2;
/** Graph allows at most 20 requests in one JSON batch. */
export const GRAPH_BATCH_LIMIT = 20;

export type GraphErrorCode =
  | 'throttled'
  | 'resync_required'
  | 'unauthorized'
  | 'credentials_rejected'
  | 'bad_response'
  | 'network'
  | 'http_error';

export class GraphError extends Error {
  constructor(
    readonly code: GraphErrorCode,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Microsoft Graph ${code} (${status})`);
    this.name = 'GraphError';
  }
}

export interface GraphClientOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface GraphUser {
  id: string;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
  accountEnabled?: boolean | null;
  userType?: string | null;
  assignedPlans?: Array<{ service?: string | null; capabilityStatus?: string | null; servicePlanId?: string | null }> | null;
  '@removed'?: { reason?: string };
}

export interface DeltaPage {
  users: GraphUser[];
  nextLink: string | null;
  deltaLink: string | null;
}

/** The properties the sync needs. Selected once, in the first request of a round. */
export const DELTA_SELECT = 'id,displayName,mail,userPrincipalName,accountEnabled,userType,assignedPlans';
export const INITIAL_DELTA_URL = `${GRAPH_ROOT}users/delta?$select=${DELTA_SELECT}`;

export function isGraphUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'graph.microsoft.com' && !url.username && !url.password
      && !url.port && url.pathname.startsWith('/v1.0/');
  } catch {
    return false;
  }
}

/** Seconds from a Retry-After header (delta-seconds or HTTP date), or null. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{1,6}$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) throw new GraphError('bad_response', response.status);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new GraphError('bad_response', response.status);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function errorCodeOf(body: unknown): string {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : '';
}

const RESYNC_CODES = new Set(['syncStateNotFound', 'resyncRequired', 'SyncStateNotFound']);
const RETRYABLE = new Set([429, 503, 504]);

export class GraphClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Graph and token requests made by this client (for per-run budgets and tests). */
  requests = 0;

  constructor(private readonly options: GraphClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    this.requests += 1;
    try {
      return await this.fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new GraphError('network', 0);
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 120_000 > this.now()) return this.token.value;
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      scope: GRAPH_SCOPE,
      grant_type: 'client_credentials',
    });
    const response = await this.send(`${LOGIN_HOST}${encodeURIComponent(this.options.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (RETRYABLE.has(response.status) || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      throw new GraphError('throttled', response.status, parseRetryAfter(response.headers.get('retry-after'), this.now()));
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GraphError('credentials_rejected', response.status);
    }
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(await readCapped(response));
    } catch (caught) {
      if (caught instanceof GraphError) throw caught;
      throw new GraphError('bad_response', response.status);
    }
    const value = typeof parsed.access_token === 'string' ? parsed.access_token : '';
    const seconds = Number(parsed.expires_in);
    if (!value || value.length > 16384) throw new GraphError('bad_response', response.status);
    this.token = { value, expiresAt: this.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 600) * 1000 };
    return value;
  }

  /** One Graph call with in-place retry for short throttling waits. */
  private async graphJson(url: string, init: { method: 'GET' | 'POST'; body?: string }): Promise<unknown> {
    if (!isGraphUrl(url)) throw new GraphError('bad_response', 0);
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.accessToken();
      const response = await this.send(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body,
      });
      if (RETRYABLE.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const wait = parseRetryAfter(response.headers.get('retry-after'), this.now());
        if (wait !== null && wait <= MAX_INLINE_WAIT_SECONDS && attempt < MAX_INLINE_RETRIES) {
          await this.sleep(wait * 1000);
          continue;
        }
        throw new GraphError('throttled', response.status, wait);
      }
      if (response.status === 410) {
        await response.body?.cancel().catch(() => undefined);
        throw new GraphError('resync_required', 410);
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new GraphError('unauthorized', response.status);
      }
      let parsed: unknown = null;
      const text = await readCapped(response);
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        throw new GraphError('bad_response', response.status);
      }
      if (!response.ok) {
        if (RESYNC_CODES.has(errorCodeOf(parsed))) throw new GraphError('resync_required', response.status);
        throw new GraphError(response.status >= 500 ? 'throttled' : 'http_error', response.status, null);
      }
      return parsed;
    }
  }

  /** One users/delta page. `url` is the initial URL, a nextLink or a deltaLink. */
  async deltaPage(url: string): Promise<DeltaPage> {
    const body = await this.graphJson(url, { method: 'GET' }) as Record<string, unknown> | null;
    if (!body || !Array.isArray(body.value)) throw new GraphError('bad_response', 200);
    const next = body['@odata.nextLink'];
    const delta = body['@odata.deltaLink'];
    const nextLink = next === undefined ? null : next;
    const deltaLink = delta === undefined ? null : delta;
    if ((nextLink !== null && !isGraphUrl(nextLink)) || (deltaLink !== null && !isGraphUrl(deltaLink))) {
      throw new GraphError('bad_response', 200);
    }
    if ((nextLink === null) === (deltaLink === null)) throw new GraphError('bad_response', 200);
    const users = (body.value as unknown[]).filter((item): item is GraphUser =>
      Boolean(item) && typeof item === 'object' && typeof (item as GraphUser).id === 'string');
    return { users, nextLink: nextLink as string | null, deltaLink: deltaLink as string | null };
  }

  /**
   * For each object id, the subset of `groupIds` it belongs to (transitively),
   * using JSON batching: one HTTP request per 20 objects. Any throttled or
   * failed item fails the whole call, so a page is never half-classified.
   */
  async memberGroups(objectIds: string[], groupIds: string[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    for (let start = 0; start < objectIds.length; start += GRAPH_BATCH_LIMIT) {
      const slice = objectIds.slice(start, start + GRAPH_BATCH_LIMIT);
      const requests = slice.map((id, index) => ({
        id: String(index),
        method: 'POST',
        url: `/users/${encodeURIComponent(id)}/checkMemberGroups`,
        headers: { 'Content-Type': 'application/json' },
        body: { groupIds },
      }));
      const body = await this.graphJson(`${GRAPH_ROOT}$batch`, { method: 'POST', body: JSON.stringify({ requests }) }) as
        { responses?: Array<{ id?: string; status?: number; headers?: Record<string, string>; body?: unknown }> } | null;
      if (!body || !Array.isArray(body.responses)) throw new GraphError('bad_response', 200);
      let longestWait: number | null = null;
      let throttled = false;
      for (const item of body.responses) {
        const index = Number(item.id);
        const objectId = slice[index];
        if (!objectId) throw new GraphError('bad_response', 200);
        const status = Number(item.status);
        if (RETRYABLE.has(status)) {
          throttled = true;
          const headers = Object.fromEntries(Object.entries(item.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
          const wait = parseRetryAfter(headers['retry-after'], this.now());
          if (wait !== null) longestWait = Math.max(longestWait ?? 0, wait);
          continue;
        }
        if (status === 404) {
          // Deleted between the delta page and this check: a member of nothing.
          result.set(objectId, new Set());
          continue;
        }
        if (status === 401 || status === 403) throw new GraphError('unauthorized', status);
        if (status !== 200) throw new GraphError('http_error', status);
        const value = (item.body as { value?: unknown } | null)?.value;
        if (!Array.isArray(value)) throw new GraphError('bad_response', 200);
        result.set(objectId, new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.toLowerCase())));
      }
      if (throttled) throw new GraphError('throttled', 429, longestWait);
      if (slice.some((id) => !result.has(id))) throw new GraphError('bad_response', 200);
    }
    return result;
  }
}
