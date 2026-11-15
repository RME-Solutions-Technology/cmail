// Minimal Cloudflare API client for the standby switch scripts.
//
// - Talks only to https://api.cloudflare.com/client/v4/ and follows no
//   redirects, so the token is never sent anywhere else.
// - The token comes from the caller (normally CLOUDFLARE_API_TOKEN). It is
//   never printed: every error message is passed through redact() first.
// - fetch is injectable so the tests run against a mock with no network.

export const API_BASE = 'https://api.cloudflare.com/client/v4/';
const TIMEOUT_MS = 30_000;
const MAX_PAGES = 200;
/** Documented per_page limits: zones and Email Routing rules 5 to 50; DNS records 1 to 5,000,000. */
export const PER_PAGE = { zones: 50, rules: 50, dnsRecords: 100 };

export class CloudflareError extends Error {
  /**
   * @param {string} message already redacted
   * @param {{ status?: number, codes?: number[], definite?: boolean }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'CloudflareError';
    this.status = info.status ?? 0;
    this.codes = info.codes ?? [];
    // True only when Cloudflare answered with a 4xx and success:false: the
    // request was refused, so a write made no change. A timeout, network
    // error, 5xx or unreadable answer leaves the outcome unknown.
    this.definite = info.definite === true;
  }
}

/**
 * @param {{ token: string, fetch?: typeof fetch }} options
 */
export function createClient({ token, fetch: fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || token.trim().length < 20 || /\s/.test(token.trim())) {
    throw new CloudflareError('CLOUDFLARE_API_TOKEN is not set or does not look like an API token.');
  }
  const secret = token.trim();

  function redact(text) {
    return String(text ?? '').split(secret).join('[redacted]');
  }

  /**
   * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
   * @param {string} path relative to API_BASE, no leading slash
   * @param {unknown} [body]
   */
  async function request(method, path, body) {
    if (typeof path !== 'string' || path.startsWith('/') || /^[a-z]+:/i.test(path) || path.includes('..')) {
      throw new CloudflareError('Refusing an API path that is not relative to the Cloudflare API base.');
    }
    const url = new URL(path, API_BASE);
    if (url.origin !== 'https://api.cloudflare.com' || !url.pathname.startsWith('/client/v4/')) {
      throw new CloudflareError('Refusing a URL outside https://api.cloudflare.com/client/v4/.');
    }
    /** @type {RequestInit} */
    const init = {
      method,
      redirect: 'error',
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetchImpl(url.toString(), init);
    } catch (error) {
      throw new CloudflareError(`${method} ${url.pathname}: network error (${redact(error?.message || error)})`);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const codes = Array.isArray(payload?.errors) ? payload.errors.map((item) => Number(item?.code)).filter(Number.isFinite) : [];
    if (!response.ok || !payload || payload.success !== true) {
      const detail = Array.isArray(payload?.errors) && payload.errors.length
        ? payload.errors.map((item) => `${item?.code ?? '?'} ${item?.message ?? ''}`.trim()).join('; ')
        : 'no error detail';
      throw new CloudflareError(redact(`${method} ${url.pathname}: HTTP ${response.status}: ${detail}`), {
        status: response.status,
        codes,
        definite: response.status >= 400 && response.status < 500 && payload?.success === false,
      });
    }
    return payload;
  }

  /** GET every page of a list endpoint. */
  async function list(path, query, perPage) {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ ...query, page: String(page), per_page: String(perPage) });
      const payload = await request('GET', `${path}?${params}`);
      const result = Array.isArray(payload.result) ? payload.result : [];
      items.push(...result);
      const totalPages = Number(payload.result_info?.total_pages);
      if (Number.isFinite(totalPages) && totalPages > 0 ? page >= totalPages : result.length < perPage) return items;
    }
    throw new CloudflareError(`${path}: more than ${MAX_PAGES} pages; refusing to continue.`);
  }

  return {
    redact,
    request,
    list,
    /** Zones whose name is exactly `name` (normally zero or one). */
    findZones: async (name) => list('zones', { name }, PER_PAGE.zones),
    listRecords: async (zoneId, type) => list(`zones/${encodeId(zoneId)}/dns_records`, { type }, PER_PAGE.dnsRecords),
    emailRoutingSettings: async (zoneId) => (await request('GET', `zones/${encodeId(zoneId)}/email/routing`)).result ?? null,
    emailRoutingRequiredDns: async (zoneId) => {
      const result = (await request('GET', `zones/${encodeId(zoneId)}/email/routing/dns`)).result;
      return Array.isArray(result) ? result : [];
    },
    emailRoutingCatchAll: async (zoneId) => (await request('GET', `zones/${encodeId(zoneId)}/email/routing/rules/catch_all`)).result ?? null,
    emailRoutingRules: async (zoneId) => list(`zones/${encodeId(zoneId)}/email/routing/rules`, {}, PER_PAGE.rules),
    /** PATCH /zones/{id}/email/routing/dns: "Unlock MX records" (Zone Settings Write). */
    unlockEmailRoutingDns: async (zoneId) => (await request('PATCH', `zones/${encodeId(zoneId)}/email/routing/dns`, {})).result ?? null,
    /** POST /zones/{id}/dns_records/batch: one database transaction (DNS Write). */
    batchRecords: async (zoneId, batch) => (await request('POST', `zones/${encodeId(zoneId)}/dns_records/batch`, batch)).result ?? null,
    /** POST /accounts/{a}/d1/database/{d}/query with a batch of read-only statements (D1 Read). */
    d1Query: async (accountId, databaseId, statements) => {
      const payload = await request('POST', `accounts/${encodeId(accountId)}/d1/database/${encodeId(databaseId)}/query`, {
        batch: statements.map((sql) => ({ sql })),
      });
      return Array.isArray(payload.result) ? payload.result : [];
    },
  };
}

function encodeId(value) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(text)) throw new CloudflareError('Refusing a malformed Cloudflare id.');
  return text;
}
