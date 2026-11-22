// Minimal Microsoft Graph client for the Microsoft 365 mailbox sync. It does
// four things only: get an app-only token (client credentials), GET a
// users/delta page, and POST a JSON $batch of checkMemberGroups calls or of
// mailboxSettings/userPurpose reads (shared mailbox detection, optional). It
// never sends a write to Microsoft. The standby copy-back client
// (../copy-back/graph.ts) extends it with its own, separately consented app
// and reuses the same token, URL, size, timeout and throttling rules.
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
    /**
     * For 'network': the underlying error's name only (for example
     * 'TypeError', 'TimeoutError'), never its message, so logs stay free of
     * URLs, tokens and addresses but the cause can still be told apart.
     */
    readonly causeName: string | null = null,
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

/**
 * Exchange Online mailbox types (mailboxSettings userPurpose, Graph v1.0):
 * user, linked, shared, room, equipment, others. Any other answer
 * (unknownFutureValue, or a value added later) is read as 'others', which the
 * sync treats like 'user': never as shared. 'none' is Stanchion's own value for
 * "Graph says this object has no Exchange Online mailbox" (404).
 */
export const MAILBOX_PURPOSES = ['user', 'linked', 'shared', 'room', 'equipment', 'others', 'none'] as const;
export type MailboxPurpose = (typeof MAILBOX_PURPOSES)[number];
/**
 * One lookup's answer: a mailbox type, or why there is none this time.
 * 'denied' = 401/403 for that mailbox (consent missing, or an Exchange
 * application access policy that leaves it out); 'failed' = any other error.
 * Neither is cached, and neither ever changes Stanchion.
 */
export type PurposeLookup = MailboxPurpose | 'denied' | 'failed';

const KNOWN_PURPOSE: ReadonlySet<string> = new Set(MAILBOX_PURPOSES.filter((value) => value !== 'none'));

/** Reads `{ "value": "shared" }` (the documented answer for .../mailboxSettings/userPurpose). */
export function parsePurpose(body: unknown): MailboxPurpose | null {
  const value = (body as { value?: unknown } | null)?.value;
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  const purpose = value.toLowerCase();
  return KNOWN_PURPOSE.has(purpose) ? purpose as MailboxPurpose : 'others';
}

export interface PurposeBatchResult {
  /** One answer per object that was not throttled. */
  purposes: Map<string, PurposeLookup>;
  /** True when at least one item was throttled (429/503/504); those objects have no answer. */
  throttled: boolean;
  /** Longest Retry-After among throttled items, in seconds, or null. */
  retryAfterSeconds: number | null;
  /** True when `maxRequests` stopped it before every object was asked. */
  incomplete: boolean;
}

export interface DeltaPage {
  users: GraphUser[];
  nextLink: string | null;
  deltaLink: string | null;
}

/** The properties the sync needs. Selected once, in the first request of a round. */
export const DELTA_SELECT = 'id,displayName,mail,userPrincipalName,accountEnabled,userType,assignedPlans';
export const INITIAL_DELTA_URL = `${GRAPH_ROOT}users/delta?$select=${DELTA_SELECT}`;

/** Users with their proxyAddresses, 999 per page (the Graph maximum for users). */
export const ALIAS_USERS_URL = `${GRAPH_ROOT}users?$select=id,proxyAddresses&$top=999`;

/** The tenant's domains with the fields the multi-domain discovery reads. */
export const DOMAINS_URL = `${GRAPH_ROOT}domains?$select=id,isVerified,isInitial,supportedServices`;

/** One domain of the tenant (Graph domain resource). */
export interface TenantDomain {
  name: string;
  isVerified: boolean;
  isInitial: boolean;
  /** supportedServices includes "Email". */
  email: boolean;
}

export interface ProxyAddressUser {
  id: string;
  /** Raw entries such as "SMTP:alice@example.com" (primary) and "smtp:al@example.com". */
  proxyAddresses: string[];
}

export interface ProxyAddressPage {
  users: ProxyAddressUser[];
  nextLink: string | null;
}

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

/** The body as bytes, or null when it is larger than `maxBytes` (the rest is not read). */
async function readBytesCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readCapped(response: Response): Promise<string> {
  const bytes = await readBytesCapped(response, MAX_BODY_BYTES);
  if (!bytes) throw new GraphError('bad_response', response.status);
  return new TextDecoder().decode(bytes);
}

function errorCodeOf(body: unknown): string {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : '';
}

/**
 * Error codes that mean "this delta or skip token is no longer usable". Graph
 * documents a 40X error with codes "such as syncStateNotFound" for an expired
 * token; the others are the same family seen across Graph change tracking.
 */
const RESYNC_CODE = /^(?:syncStateNotFound|syncStateInvalid|resyncRequired|resyncApplicationRequired|invalidDeltaToken|deltaTokenExpired|expiredDeltaToken|invalidSkipToken)$/i;
const RESYNC_STATUSES = new Set([400, 404, 409, 410]);
const RETRYABLE = new Set([429, 503, 504]);

export class GraphClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Graph and token requests made by this client (for per-run budgets and tests). */
  requests = 0;

  constructor(private readonly options: GraphClientOptions) {
    // Never store the global fetch and call it as a method: on Cloudflare
    // Workers `this.fetcher(...)` then throws "Illegal invocation". A wrapper
    // calls it unbound.
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    this.requests += 1;
    try {
      // Called unbound, never as a method of this client (see the constructor).
      const fetcher = this.fetcher;
      return await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (caught) {
      const name = caught instanceof Error && /^[A-Za-z]{1,40}$/.test(caught.name) ? caught.name : 'UnknownError';
      throw new GraphError('network', 0, null, name);
    }
  }

  protected async accessToken(): Promise<string> {
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

  /**
   * One Graph call with in-place retry for short throttling waits. Pass
   * `retryInPlace: false` for a call that is not safe to repeat blindly (a
   * create): a 503/504 can arrive after the server already stored the
   * result, so the caller must look before trying again.
   */
  protected async graphJson(url: string, init: { method: 'GET' | 'POST' | 'PATCH'; body?: string; retryInPlace?: boolean; headers?: Record<string, string> }): Promise<unknown> {
    const response = await this.graphResponse(url, { ...init, accept: 'application/json' });
    let parsed: unknown = null;
    const text = await readCapped(response);
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new GraphError('bad_response', response.status);
    }
    if (!response.ok) {
      if (RESYNC_STATUSES.has(response.status) && RESYNC_CODE.test(errorCodeOf(parsed))) throw new GraphError('resync_required', response.status);
      throw new GraphError(response.status >= 500 ? 'throttled' : 'http_error', response.status, null);
    }
    return parsed;
  }

  /**
   * One GET whose body is raw bytes (a message's MIME,
   * `.../messages/{id}/$value`), with the same token, URL, throttling and
   * error rules as graphJson. Null when the body is larger than `maxBytes`
   * (the rest is not read).
   */
  protected async graphBytes(url: string, maxBytes: number): Promise<Uint8Array | null> {
    const response = await this.graphResponse(url, { method: 'GET', accept: '*/*' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GraphError(response.status >= 500 ? 'throttled' : 'http_error', response.status, null);
    }
    return readBytesCapped(response, maxBytes);
  }

  /**
   * Sends one request and handles what every Graph call shares: in-place
   * retry of short throttling waits, 410 (resync) and 401/403. Any other
   * status is returned for the caller to read.
   */
  private async graphResponse(
    url: string,
    init: { method: 'GET' | 'POST' | 'PATCH'; body?: string; retryInPlace?: boolean; headers?: Record<string, string>; accept: string },
  ): Promise<Response> {
    if (!isGraphUrl(url)) throw new GraphError('bad_response', 0);
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.accessToken();
      const response = await this.send(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: init.accept,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        body: init.body,
      });
      if (RETRYABLE.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const wait = parseRetryAfter(response.headers.get('retry-after'), this.now());
        if (init.retryInPlace !== false && wait !== null && wait <= MAX_INLINE_WAIT_SECONDS && attempt < MAX_INLINE_RETRIES) {
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
      return response;
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
   * One page of users with their proxyAddresses, for the alias import
   * (docs/exchange-mirror.md). proxyAddresses is returned only when selected:
   * https://learn.microsoft.com/en-us/graph/api/resources/user
   * `url` is ALIAS_USERS_URL or a nextLink from the previous page.
   */
  async proxyAddressPage(url: string): Promise<ProxyAddressPage> {
    const body = await this.graphJson(url, { method: 'GET' }) as Record<string, unknown> | null;
    if (!body || !Array.isArray(body.value)) throw new GraphError('bad_response', 200);
    const next = body['@odata.nextLink'];
    const nextLink = next === undefined || next === null ? null : next;
    if (nextLink !== null && !isGraphUrl(nextLink)) throw new GraphError('bad_response', 200);
    const users: ProxyAddressUser[] = [];
    for (const item of body.value as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const record = item as { id?: unknown; proxyAddresses?: unknown };
      if (typeof record.id !== 'string') continue;
      const proxies = Array.isArray(record.proxyAddresses)
        ? record.proxyAddresses.filter((value): value is string => typeof value === 'string' && value.length <= 400).slice(0, 500)
        : [];
      users.push({ id: record.id, proxyAddresses: proxies });
    }
    return { users, nextLink: nextLink as string | null };
  }

  /**
   * Every domain of the tenant with the facts the multi-domain discovery
   * reads (docs/multi-domain.md): GET /domains with application permission
   * Domain.Read.All (https://learn.microsoft.com/en-us/graph/api/domain-list).
   * Whole listing or an error: a short page never drops a domain. The caller
   * keeps verified, non-initial domains that support Email.
   */
  async domainList(maxPages = 5): Promise<TenantDomain[]> {
    const domains: TenantDomain[] = [];
    let url: string | null = DOMAINS_URL;
    for (let pages = 0; url; pages += 1) {
      if (pages >= maxPages) throw new GraphError('bad_response', 200);
      const body = await this.graphJson(url, { method: 'GET' }) as Record<string, unknown> | null;
      if (!body || !Array.isArray(body.value)) throw new GraphError('bad_response', 200);
      for (const item of body.value as unknown[]) {
        if (!item || typeof item !== 'object') continue;
        const record = item as { id?: unknown; isVerified?: unknown; isInitial?: unknown; supportedServices?: unknown };
        if (typeof record.id !== 'string' || record.id.length > 253) continue;
        domains.push({
          name: record.id.toLowerCase(),
          isVerified: record.isVerified === true,
          isInitial: record.isInitial === true,
          email: Array.isArray(record.supportedServices) && record.supportedServices.some((service) => service === 'Email'),
        });
      }
      const next = body['@odata.nextLink'];
      if (next !== undefined && next !== null && !isGraphUrl(next)) throw new GraphError('bad_response', 200);
      url = (next ?? null) as string | null;
    }
    return domains;
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

  /**
   * Exchange Online mailbox type for each object id:
   * `GET /users/{id}/mailboxSettings/userPurpose` (application permission
   * MailboxSettings.Read), 20 per JSON `$batch`. Unlike memberGroups, one
   * object's failure does not fail the rest: a 404 is 'none' (no Exchange
   * Online mailbox), a 401/403 is 'denied' and any other error 'failed'.
   * `maxRequests` stops it before a batch once this client has made that
   * many requests (`incomplete`: the rest have no answer).
   * Throttled items (429/503/504) get no answer and are reported with the
   * longest Retry-After; no further batch is sent after a throttled one. The
   * caller keeps the answers it has and stops until the wait is over. A
   * failure of the `$batch` request itself throws as usual (429 with its
   * Retry-After, 401/403 as unauthorized).
   */
  async mailboxPurposes(objectIds: string[], options: { maxRequests?: number } = {}): Promise<PurposeBatchResult> {
    const purposes = new Map<string, PurposeLookup>();
    let throttled = false;
    let incomplete = false;
    let longestWait: number | null = null;
    for (let start = 0; start < objectIds.length; start += GRAPH_BATCH_LIMIT) {
      // The run's Graph budget is checked before every $batch, not only per page.
      if (options.maxRequests !== undefined && this.requests >= options.maxRequests) {
        incomplete = true;
        break;
      }
      const slice = objectIds.slice(start, start + GRAPH_BATCH_LIMIT);
      const requests = slice.map((id, index) => ({
        id: String(index),
        method: 'GET',
        url: `/users/${encodeURIComponent(id)}/mailboxSettings/userPurpose`,
      }));
      const body = await this.graphJson(`${GRAPH_ROOT}$batch`, { method: 'POST', body: JSON.stringify({ requests }) }) as
        { responses?: Array<{ id?: string; status?: number; headers?: Record<string, string>; body?: unknown }> } | null;
      if (!body || !Array.isArray(body.responses)) throw new GraphError('bad_response', 200);
      let batchThrottled = false;
      const answered = new Set<string>();
      for (const item of body.responses) {
        const objectId = slice[Number(item?.id)];
        if (!objectId || !/^\d{1,2}$/.test(String(item?.id))) throw new GraphError('bad_response', 200);
        answered.add(objectId);
        const status = Number(item.status);
        if (RETRYABLE.has(status)) {
          batchThrottled = true;
          const headers = Object.fromEntries(Object.entries(item.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
          const wait = parseRetryAfter(headers['retry-after'], this.now());
          if (wait !== null) longestWait = Math.max(longestWait ?? 0, wait);
          continue;
        }
        if (status === 200) purposes.set(objectId, parsePurpose(item.body) ?? 'failed');
        else if (status === 404) purposes.set(objectId, 'none');
        else if (status === 401 || status === 403) purposes.set(objectId, 'denied');
        else purposes.set(objectId, 'failed');
      }
      if (slice.some((id) => !answered.has(id))) throw new GraphError('bad_response', 200);
      if (batchThrottled) {
        // Stop sending more batches into a throttled service; the rest wait too.
        throttled = true;
        break;
      }
    }
    return { purposes, throttled, retryAfterSeconds: longestWait, incomplete };
  }
}
