// In-memory stand-in for the parts of the Cloudflare API the standby scripts
// call. No network: tests pass mock.fetch as the client's fetch. Behaviour
// follows the documented API (batch is all-or-nothing; locked Email Routing
// records cannot be changed until PATCH email/routing/dns unlocks them).

export const TEST_TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuv';
export const ZONE_ID = '0123456789abcdef0123456789abcdef';
export const ACCOUNT_ID = 'fedcba9876543210fedcba9876543210';
export const D1_ID = '00000000-0000-0000-0000-000000000000';
export const DOMAIN = 'example.com';
export const WORKER = 'cmail-email';

const HOUR = 60 * 60 * 1000;

export function exchangeMx(overrides = {}) {
  return { type: 'MX', name: DOMAIN, content: 'example-com.mail.protection.outlook.test', priority: 0, ttl: 300, proxied: false, comment: null, ...overrides };
}

/** A zone prepared as docs/standby-switch.md expects before a switch. */
export function preparedState() {
  return {
    zones: [{ id: ZONE_ID, name: DOMAIN, type: 'full', status: 'active' }],
    records: [
      exchangeMx(),
      { type: 'TXT', name: DOMAIN, content: '"v=spf1 include:spf.protection.outlook.com -all"', ttl: 1, proxied: false, comment: null },
      { type: 'TXT', name: DOMAIN, content: '"google-site-verification=placeholder"', ttl: 1, proxied: false, comment: null },
      { type: 'TXT', name: `_dmarc.${DOMAIN}`, content: '"v=DMARC1; p=quarantine"', ttl: 1, proxied: false, comment: null },
      { type: 'CNAME', name: `selector1._domainkey.${DOMAIN}`, content: 'selector1-example-com._domainkey.example.onmicrosoft.test', ttl: 1, proxied: false, comment: null },
      { type: 'TXT', name: `cf2024-1._domainkey.${DOMAIN}`, content: '"v=DKIM1; h=sha256; k=rsa; p=placeholder"', ttl: 1, proxied: false, comment: null },
      { type: 'MX', name: `standby.${DOMAIN}`, content: 'route1.mx.cloudflare.net', priority: 13, ttl: 1, proxied: false, comment: null, locked: true },
      { type: 'MX', name: `standby.${DOMAIN}`, content: 'route2.mx.cloudflare.net', priority: 24, ttl: 1, proxied: false, comment: null, locked: true },
      { type: 'A', name: `www.${DOMAIN}`, content: '192.0.2.10', ttl: 1, proxied: true, comment: null },
    ],
    settings: { id: 'settings', enabled: true, name: DOMAIN, status: 'unlocked' },
    requiredDns: [
      { type: 'MX', name: DOMAIN, content: 'route1.mx.cloudflare.net', priority: 13, ttl: 1 },
      { type: 'MX', name: DOMAIN, content: 'route2.mx.cloudflare.net', priority: 24, ttl: 1 },
      { type: 'MX', name: DOMAIN, content: 'route3.mx.cloudflare.net', priority: 86, ttl: 1 },
      { type: 'TXT', name: DOMAIN, content: 'v=spf1 include:_spf.mx.cloudflare.net ~all', ttl: 1 },
    ],
    catchAll: { id: 'catchall', enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [WORKER] }], name: 'catch-all' },
    rules: [],
    d1: { enabled: 'true', runs: [{ status: 'pass', reason: '', warnings: '', started_at: 0, received_at: 0 }] },
    probeAge: 2 * HOUR,
  };
}

export class MockCloudflare {
  constructor(state = preparedState(), { now = Date.UTC(2026, 10, 15, 3, 0, 0), maxPerPage = 2 } = {}) {
    this.now = now;
    this.maxPerPage = maxPerPage;
    this.zones = state.zones;
    this.settings = state.settings;
    this.requiredDns = state.requiredDns;
    this.catchAll = state.catchAll;
    this.rules = state.rules;
    this.d1 = state.d1;
    if (this.d1?.runs) {
      // Make probe times relative to the test clock.
      this.d1 = { ...this.d1, runs: this.d1.runs.map((run) => ({ ...run, started_at: now - state.probeAge - 60_000, received_at: now - state.probeAge })) };
    }
    this.records = new Map();
    this.nextId = 1;
    for (const record of state.records) this.add(record);
    this.calls = [];
    this.failBatch = null;
    this.errorFor = new Map();
    this.fetch = this.fetch.bind(this);
  }

  add(record) {
    const id = `rec${String(this.nextId++).padStart(29, '0')}`;
    this.records.set(id, { ...record, id });
    return id;
  }

  writes() {
    return this.calls.filter((call) => call.method !== 'GET' && !call.path.endsWith('/query'));
  }

  apexMx() {
    return [...this.records.values()].filter((r) => r.type === 'MX' && r.name === DOMAIN)
      .map((r) => `${r.priority} ${r.content} ttl ${r.ttl}`).sort();
  }

  spf() {
    return [...this.records.values()].filter((r) => r.type === 'TXT' && r.name === DOMAIN && /v=spf1/i.test(r.content)).map((r) => r.content);
  }

  async fetch(input, init = {}) {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/client\/v4/, '');
    this.calls.push({ method, path, query: url.search, body, redirect: init.redirect, host: url.host });
    if (init.headers?.Authorization !== `Bearer ${TEST_TOKEN}`) return reply(403, fail(10000, 'Authentication error'));
    const forced = this.errorFor.get(`${method} ${path}`);
    if (forced) return reply(forced.status, fail(forced.code, forced.message));
    const z = `/zones/${ZONE_ID}`;

    if (method === 'GET' && path === '/zones') {
      return this.page(this.zones.filter((zone) => zone.name === url.searchParams.get('name')), url);
    }
    if (method === 'GET' && path === `${z}/dns_records`) {
      const type = url.searchParams.get('type');
      return this.page([...this.records.values()].filter((r) => !type || r.type === type).map(strip), url);
    }
    if (method === 'GET' && path === `${z}/email/routing`) return reply(200, ok(this.settings));
    if (method === 'GET' && path === `${z}/email/routing/dns`) return reply(200, ok(this.requiredDns));
    if (method === 'PATCH' && path === `${z}/email/routing/dns`) {
      for (const record of this.records.values()) delete record.locked;
      this.settings = { ...this.settings, status: 'unlocked' };
      return reply(200, ok(this.settings));
    }
    if (method === 'GET' && path === `${z}/email/routing/rules/catch_all`) {
      if (this.catchAll === undefined) return reply(200, ok(null));
      return this.catchAll ? reply(200, ok(this.catchAll)) : reply(404, fail(1000, 'not found'));
    }
    if (method === 'GET' && path === `${z}/email/routing/rules`) return this.page(this.rules, url);
    if (method === 'POST' && path === `${z}/dns_records/batch`) return this.batch(body);
    if (method === 'POST' && path === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) return this.query(body);
    return reply(404, fail(7003, 'Could not route to this path'));
  }

  page(items, url) {
    const perPage = Math.min(Number(url.searchParams.get('per_page') || 20), this.maxPerPage);
    const page = Number(url.searchParams.get('page') || 1);
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    return reply(200, {
      ...ok(items.slice((page - 1) * perPage, page * perPage)),
      result_info: { page, per_page: perPage, count: 0, total_count: items.length, total_pages: totalPages },
    });
  }

  batch(body) {
    if (this.failBatch) return reply(400, fail(this.failBatch.code, this.failBatch.message));
    const next = new Map([...this.records].map(([id, r]) => [id, { ...r }]));
    for (const del of body.deletes ?? []) {
      const record = next.get(del.id);
      if (!record) return reply(400, fail(81044, `Record ${del.id} does not exist.`));
      if (record.locked) return reply(400, fail(1004, 'Record is locked by Email Routing.'));
      next.delete(del.id);
    }
    for (const patch of body.patches ?? []) {
      const record = next.get(patch.id);
      if (!record) return reply(400, fail(81044, `Record ${patch.id} does not exist.`));
      if (record.locked) return reply(400, fail(1004, 'Record is locked by Email Routing.'));
      next.set(patch.id, { ...record, ...patch });
    }
    const posted = [];
    for (const post of body.posts ?? []) {
      if (!post.type || !post.name || !post.content) return reply(400, fail(9000, 'Invalid record.'));
      const id = `rec${String(this.nextId++).padStart(29, '0')}`;
      const record = { proxied: false, comment: null, ...post, id };
      next.set(id, record);
      posted.push(strip(record));
    }
    this.records = next;
    return reply(200, ok({ deletes: body.deletes ?? [], patches: body.patches ?? [], posts: posted }));
  }

  query(body) {
    if (!this.d1) return reply(400, fail(7500, 'no such table: standby_probe_runs'));
    const results = (body.batch ?? []).map(({ sql }) => {
      if (/FROM org_settings/.test(sql)) return { success: true, results: this.d1.enabled === undefined ? [] : [{ value: this.d1.enabled }], meta: {} };
      if (/FROM standby_probe_runs/.test(sql)) return { success: true, results: this.d1.runs, meta: {} };
      return { success: false, results: [], meta: {} };
    });
    return reply(200, ok(results));
  }
}

function strip(record) {
  const { locked: _locked, ...rest } = record;
  return rest;
}

function ok(result) {
  return { success: true, errors: [], messages: [], result };
}

function fail(code, message) {
  return { success: false, errors: [{ code, message }], messages: [], result: null };
}

function reply(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
