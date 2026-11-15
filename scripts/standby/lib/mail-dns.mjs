// Pure logic for the standby switch: which records matter, what the switch
// and switch-back change, and the checks that refuse. No I/O here, so every
// rule is unit-tested directly. The design and its limits are in
// docs/standby-switch.md.

export const CLOUDFLARE_MX_SUFFIX = '.mx.cloudflare.net';
export const CLOUDFLARE_SPF_INCLUDE = 'include:_spf.mx.cloudflare.net';
/** Cloudflare's "Auto" TTL value; Auto is 300 seconds for records that are not proxied. */
export const AUTO_TTL = 1;
export const AUTO_TTL_SECONDS = 300;
export const DEFAULT_MAX_TTL = 300;
const SPF_LOOKUP_LIMIT = 10;

const DOMAIN_RX = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const HOST_RX = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normaliseDomain(value) {
  const domain = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  return DOMAIN_RX.test(domain) ? domain : null;
}

export function normaliseHost(value) {
  const host = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  return HOST_RX.test(host) ? host : null;
}

export function isCloudflareMxHost(host) {
  const value = normaliseHost(host);
  return Boolean(value && value.endsWith(CLOUDFLARE_MX_SUFFIX) && value.length > CLOUDFLARE_MX_SUFFIX.length);
}

/** Seconds a resolver may cache the record. Auto (1) is 300. */
export function effectiveTtl(ttl) {
  const value = Number(ttl);
  return value === AUTO_TTL ? AUTO_TTL_SECONDS : value;
}

/** The fields a snapshot keeps, in a fixed order. */
export function pickRecord(record) {
  return {
    id: String(record.id ?? ''),
    type: String(record.type ?? ''),
    name: String(record.name ?? '').toLowerCase().replace(/\.$/, ''),
    content: String(record.content ?? ''),
    priority: record.priority === undefined || record.priority === null ? null : Number(record.priority),
    ttl: Number(record.ttl),
    proxied: record.proxied === true,
    comment: typeof record.comment === 'string' ? record.comment : null,
  };
}

function nameIs(record, name) {
  return String(record.name ?? '').toLowerCase().replace(/\.$/, '') === name;
}

// ─── SPF ──────────────────────────────────────────────────────────────────

/**
 * Splits TXT content into its text. Cloudflare may return TXT content with
 * or without surrounding quotes. A record made of several quoted strings is
 * reported as `multi` and never edited automatically.
 */
export function readTxt(content) {
  const raw = String(content ?? '');
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    const quotedString = /"((?:[^"\\]|\\.)*)"/g;
    const parts = [...trimmed.matchAll(quotedString)];
    const leftover = trimmed.replace(quotedString, '').trim();
    // Several strings, or anything outside the quotes: never edited automatically.
    if (parts.length !== 1 || leftover) return { text: null, quoted: true, multi: true };
    return { text: parts[0][1], quoted: true, multi: false };
  }
  return { text: raw, quoted: false, multi: false };
}

export function isSpf(record) {
  if (record.type !== 'TXT') return false;
  const { text, multi } = readTxt(record.content);
  if (multi) return /^"v=spf1(\s|")/i.test(String(record.content).trim());
  return /^v=spf1(\s|$)/i.test(String(text).trim());
}

/** Top-level SPF terms that cost a DNS lookup (RFC 7208 section 4.6.4). Nested includes are not counted. */
export function spfTopLevelLookups(text) {
  return String(text).trim().split(/\s+/).slice(1).filter((term) => {
    const bare = term.replace(/^[+\-~?]/, '').toLowerCase();
    return /^(include:|a$|a:|a\/|mx$|mx:|mx\/|ptr$|ptr:|exists:|redirect=)/.test(bare);
  }).length;
}

/**
 * The SPF edit the switch makes, or why it makes none. Cloudflare documents
 * that an existing SPF record keeps its own terms and gains
 * `include:_spf.mx.cloudflare.net`; Exchange's include is never removed.
 */
export function planSpf(spfRecords) {
  if (spfRecords.length === 0) {
    return { action: 'none', note: 'No SPF record on the domain. The switch does not create one (a Cloudflare-only SPF record would stop authorising Exchange). Add an SPF record that covers your outbound mail first.' };
  }
  if (spfRecords.length > 1) {
    return { action: 'refuse', note: `The domain has ${spfRecords.length} SPF records, which is already invalid (RFC 7208 allows one). Fix it by hand first, or run with --no-spf-change.` };
  }
  const record = spfRecords[0];
  const { text, quoted, multi } = readTxt(record.content);
  if (multi || text === null) {
    return { action: 'refuse', note: 'The SPF record is split into several strings; the script does not edit it. Add the include by hand, or run with --no-spf-change.' };
  }
  const terms = text.trim().split(/\s+/);
  if (terms.some((term) => term.toLowerCase() === CLOUDFLARE_SPF_INCLUDE)) {
    return { action: 'none', note: 'SPF already includes _spf.mx.cloudflare.net.' };
  }
  const after = [terms[0], CLOUDFLARE_SPF_INCLUDE, ...terms.slice(1)].join(' ');
  const lookups = spfTopLevelLookups(after);
  if (lookups > SPF_LOOKUP_LIMIT) {
    return { action: 'refuse', note: `Adding the include would make ${lookups} top-level SPF lookups (limit ${SPF_LOOKUP_LIMIT}). Flatten the record first, or run with --no-spf-change.` };
  }
  const afterContent = quoted ? `"${after}"` : after;
  return {
    action: 'edit',
    recordId: record.id,
    before: record.content,
    after: afterContent,
    note: `Adds ${CLOUDFLARE_SPF_INCLUDE} and keeps every existing term (${lookups} top-level lookups after; nested includes are not counted, check the total with an SPF checker).`,
  };
}

// ─── Reading the zone ─────────────────────────────────────────────────────

/**
 * Groups the zone's records into the ones the switch reads.
 * @param {string} domain apex, already normalised
 * @param {{ mx: object[], txt: object[], cname: object[] }} records
 * @param {string} standbyLabel
 */
export function classifyMailRecords(domain, records, standbyLabel) {
  const standbyName = `${standbyLabel}.${domain}`;
  const dkimSuffix = `._domainkey.${domain}`;
  // Sorted, so two reads of an unchanged zone compare equal whatever order the API lists them in.
  const pick = (list) => list.map(pickRecord).sort((a, b) => `${a.name}|${a.content}|${a.id}`.localeCompare(`${b.name}|${b.content}|${b.id}`));
  return {
    apexMx: pick(records.mx.filter((r) => nameIs(r, domain))),
    apexSpf: pick(records.txt.filter((r) => nameIs(r, domain) && isSpf(r))),
    dmarc: pick(records.txt.filter((r) => nameIs(r, `_dmarc.${domain}`))),
    dkim: pick([...records.txt, ...records.cname].filter((r) => String(r.name ?? '').toLowerCase().endsWith(dkimSuffix))),
    standbyMx: pick(records.mx.filter((r) => nameIs(r, standbyName))),
  };
}

/**
 * The Cloudflare MX records to point the apex at, from Cloudflare's own
 * "Email Routing DNS settings" answer, or from --cloudflare-mx when that
 * answer lists none.
 */
export function targetCloudflareMx(domain, requiredDns, override) {
  const listed = (requiredDns ?? [])
    .filter((r) => String(r.type).toUpperCase() === 'MX')
    .filter((r) => {
      const name = String(r.name ?? '').toLowerCase().replace(/\.$/, '');
      return name === domain || name === '@' || name === '';
    })
    .map((r) => ({ content: normaliseHost(r.content), priority: Number(r.priority) }));
  const bad = listed.filter((r) => !r.content || !isCloudflareMxHost(r.content) || !Number.isInteger(r.priority) || r.priority < 0 || r.priority > 65535);
  if (bad.length) return { ok: false, error: 'Cloudflare listed an MX record that is not a valid *.mx.cloudflare.net host with a priority. Stopping.' };
  if (listed.length && override) {
    return { ok: false, error: 'Cloudflare lists the Email Routing MX records for this zone; remove --cloudflare-mx and use what Cloudflare lists.' };
  }
  if (listed.length) return { ok: true, source: 'cloudflare', mx: dedupeMx(listed) };
  if (!override) {
    return { ok: false, error: 'Cloudflare listed no Email Routing MX records for this zone. Copy them from Email Routing > Settings > DNS records and pass --cloudflare-mx host:priority,host:priority.' };
  }
  const parsed = parseMxList(override);
  if (!parsed.ok) return parsed;
  return { ok: true, source: 'flag', mx: parsed.mx };
}

export function parseMxList(value) {
  const items = String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!items.length) return { ok: false, error: '--cloudflare-mx is empty.' };
  const mx = [];
  for (const item of items) {
    const match = item.match(/^([^:\s]+):(\d{1,5})$/);
    const host = match ? normaliseHost(match[1]) : null;
    const priority = match ? Number(match[2]) : NaN;
    if (!host || !isCloudflareMxHost(host) || priority > 65535) {
      return { ok: false, error: `--cloudflare-mx entries must look like route1.mx.cloudflare.net:13 (got "${item.slice(0, 80)}").` };
    }
    mx.push({ content: host, priority });
  }
  return { ok: true, mx: dedupeMx(mx) };
}

function dedupeMx(list) {
  const seen = new Set();
  return list.filter((r) => {
    const key = `${r.content}|${r.priority}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Checks ───────────────────────────────────────────────────────────────

export function checkZone(zones, domain) {
  if (!zones.length) return { ok: false, error: `No Cloudflare zone named ${domain} in this account. The switch needs the domain's DNS on Cloudflare, and the domain must be the zone apex.` };
  if (zones.length > 1) return { ok: false, error: `More than one zone named ${domain}; stopping.` };
  const zone = zones[0];
  if (String(zone.name).toLowerCase() !== domain) return { ok: false, error: 'Zone name does not match the domain; stopping.' };
  if (zone.type !== 'full') return { ok: false, error: `Zone ${domain} is type "${zone.type}", not "full": its DNS is not hosted on Cloudflare, and Email Routing needs Cloudflare DNS.` };
  if (zone.status !== 'active') return { ok: false, error: `Zone ${domain} is "${zone.status}", not active.` };
  return { ok: true, zone };
}

/** Records above maxTtl that must be lowered before the switch. */
export function ttlProblems(records, maxTtl) {
  return records.filter((r) => effectiveTtl(r.ttl) > maxTtl);
}

export function ttlAdvice(records, maxTtl) {
  const longest = Math.max(...records.map((r) => effectiveTtl(r.ttl)));
  return [
    `These MX records have a TTL above ${maxTtl} seconds:`,
    ...records.map((r) => `  MX ${r.priority} ${r.content} ttl ${effectiveTtl(r.ttl)}s`),
    'Lower them first, then wait out the old TTL before switching:',
    `  1. Cloudflare dashboard > the zone > DNS > Records > edit each MX record > TTL "Auto" (300s) or ${maxTtl}s.`,
    `  2. Wait at least ${longest} seconds (the old TTL) so resolvers drop the long-cached answer.`,
    '  Do this days ahead as routine prep: lowering a TTL is safe and changes nowhere mail goes.',
  ];
}

/**
 * Email Routing must already be on for this zone, with the apex MX records
 * unlocked and pointing elsewhere (docs/standby-switch.md, "First-time
 * setup"). Anything else is refused.
 */
export function checkEmailRouting(settings) {
  if (!settings || settings.enabled !== true) {
    return {
      ok: false,
      error: 'Email Routing is not enabled on this zone. Cloudflare refuses to enable it while other MX records exist (error 2008), so the switch does not do first-time onboarding. Follow "First-time setup" in docs/standby-switch.md.',
    };
  }
  if (settings.status === 'misconfigured/locked') {
    return { ok: false, error: 'Email Routing status is "misconfigured/locked": its records are locked. Unlock them in Email Routing > Settings > DNS records first.' };
  }
  if (!['unlocked', 'misconfigured', 'ready'].includes(settings.status)) {
    return { ok: false, error: `Email Routing status is "${settings.status ?? 'unknown'}", which the switch does not know how to handle.` };
  }
  return { ok: true };
}

export function checkCatchAll(catchAll, worker) {
  const actions = Array.isArray(catchAll?.actions) ? catchAll.actions : [];
  const matchers = Array.isArray(catchAll?.matchers) ? catchAll.matchers : [];
  const target = actions.length === 1 && actions[0]?.type === 'worker' && Array.isArray(actions[0].value) && actions[0].value.length === 1
    ? String(actions[0].value[0])
    : null;
  if (!catchAll || catchAll.enabled !== true || target !== worker || !matchers.some((m) => m?.type === 'all')) {
    const now = !catchAll ? 'not readable' : `${catchAll.enabled === true ? 'enabled' : 'disabled'}, action ${actions.map((a) => `${a?.type}${Array.isArray(a?.value) && a.value.length ? ` ${a.value.join(',')}` : ''}`).join('; ') || 'none'}`;
    return {
      ok: false,
      error: `The apex catch-all rule must be enabled and send to Worker "${worker}" before the switch (now: ${now}). With Cloudflare's MX in place, mail to an address with no rule is rejected with "Address does not exist" and senders do not retry. Set it in Email Routing > Routing rules > Catch-all address.`,
    };
  }
  return { ok: true };
}

/** Literal apex rules that send somewhere other than the Worker take those addresses first. */
export function literalRuleWarnings(rules, domain, worker) {
  const warnings = [];
  for (const rule of rules ?? []) {
    if (rule?.enabled !== true) continue;
    const matchers = Array.isArray(rule.matchers) ? rule.matchers : [];
    if (!matchers.some((m) => m?.type === 'literal')) continue;
    const addresses = matchers.filter((m) => m?.type === 'literal').map((m) => String(m.value ?? '').toLowerCase());
    if (!addresses.some((a) => a.endsWith(`@${domain}`))) continue;
    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    const toWorker = actions.length > 0 && actions.every((a) => a?.type === 'worker' && Array.isArray(a.value) && a.value.every((v) => v === worker));
    if (!toWorker) {
      warnings.push(`Rule "${rule.name || rule.id || 'unnamed'}" for ${addresses.join(', ')} does not go to the Worker; those addresses will not reach cmail after the switch.`);
    }
  }
  return warnings;
}

// ─── Plans ────────────────────────────────────────────────────────────────

/**
 * The switch's change set: one DNS batch (Cloudflare runs it in one database
 * transaction, so it applies completely or not at all).
 */
export function planSwitch({ domain, mail, targetMx, spfPlan, maxTtl, stamp }) {
  const nonCf = mail.apexMx.filter((r) => !isCloudflareMxHost(r.content));
  const cf = mail.apexMx.filter((r) => isCloudflareMxHost(r.content));
  if (!mail.apexMx.length) return { ok: false, error: 'The domain has no MX records at the apex: there is nothing to switch from, and nothing to switch back to.' };
  if (!nonCf.length) return { ok: true, nothingToDo: true, note: 'Every apex MX record already points to Cloudflare: mail is already on the standby.' };
  if (cf.length) return { ok: false, error: 'The apex has both Cloudflare and other MX records. That is a half-switched state; fix it by hand (or run switch-back with the right snapshot) first.' };
  if (nonCf.some((r) => r.proxied)) return { ok: false, error: 'An MX record is marked proxied, which is not valid; stopping.' };
  const ttl = maxTtl >= AUTO_TTL_SECONDS ? AUTO_TTL : maxTtl;
  const posts = targetMx.map((mx) => ({
    type: 'MX',
    name: domain,
    content: mx.content,
    priority: mx.priority,
    ttl,
    comment: `cmail standby switch ${stamp}`,
  }));
  const patches = spfPlan.action === 'edit' ? [{ id: spfPlan.recordId, content: spfPlan.after }] : [];
  return {
    ok: true,
    nothingToDo: false,
    batch: { deletes: nonCf.map((r) => ({ id: r.id })), patches, posts },
    describe: {
      deletes: nonCf,
      posts,
      spf: spfPlan.action === 'edit' ? { before: spfPlan.before, after: spfPlan.after } : null,
    },
  };
}

/**
 * The switch-back's change set, from a snapshot's original records and the
 * zone as it is now. Restores the original MX records exactly (host,
 * priority, TTL, comment) and the SPF record only if it still holds what the
 * switch wrote.
 */
export function planSwitchBack({ snapshot, mail }) {
  const original = snapshot.records.apexMx;
  if (!original.length) return { ok: false, error: 'The snapshot has no apex MX records; it cannot be used to switch back.' };
  if (original.some((r) => isCloudflareMxHost(r.content))) {
    return { ok: false, error: 'The snapshot was taken while the apex already pointed to Cloudflare; it does not hold the Exchange records. Use the snapshot from before the switch.' };
  }
  const key = (r) => `${normaliseHost(r.content)}|${Number(r.priority)}`;
  const originalKeys = new Set(original.map(key));
  const currentCf = mail.apexMx.filter((r) => isCloudflareMxHost(r.content));
  const currentOther = mail.apexMx.filter((r) => !isCloudflareMxHost(r.content));
  const unknownOther = currentOther.filter((r) => !originalKeys.has(key(r)));
  if (unknownOther.length) {
    return { ok: false, error: `The apex has MX records that are neither Cloudflare's nor in the snapshot (${unknownOther.map((r) => r.content).join(', ')}). Someone changed DNS since; sort it out by hand.` };
  }
  const currentKeys = new Set(currentOther.map(key));
  const missing = original.filter((r) => !currentKeys.has(key(r)));
  const spf = planSpfRestore(snapshot, mail);
  const posts = missing.map((r) => {
    const post = { type: 'MX', name: r.name, content: r.content, priority: r.priority, ttl: r.ttl };
    if (r.comment !== null) post.comment = r.comment;
    return post;
  });
  const patches = spf.action === 'edit' ? [spf.patch] : [];
  return {
    ok: true,
    nothingToDo: !currentCf.length && !posts.length && !patches.length,
    spf,
    expectedMx: original,
    batch: { deletes: currentCf.map((r) => ({ id: r.id })), patches, posts },
    describe: { deletes: currentCf, posts, spf: spf.describe ?? null },
  };
}

function planSpfRestore(snapshot, mail) {
  const change = snapshot.plan?.spf;
  if (!change) return { action: 'none', note: 'The switch did not change SPF.' };
  const current = mail.apexSpf;
  if (current.length !== 1) return { action: 'leave', note: `Expected one SPF record, found ${current.length}; SPF left as it is. Check it by hand.` };
  if (current[0].content === change.before) return { action: 'none', note: 'SPF is already as it was before the switch.' };
  if (current[0].content !== change.after) {
    return { action: 'leave', note: 'SPF has been edited since the switch; left as it is. Remove include:_spf.mx.cloudflare.net by hand if you no longer want it.' };
  }
  return {
    action: 'edit',
    patch: { id: current[0].id, content: change.before },
    describe: { before: change.after, after: change.before },
    note: 'Restores the SPF record to its content before the switch.',
  };
}

/** Did the zone end up as planned? Compares MX by host and priority, SPF by content. */
export function verifyMx(mail, expected) {
  const key = (r) => `${normaliseHost(r.content)}|${Number(r.priority)}`;
  const have = new Set(mail.apexMx.map(key));
  const want = new Set(expected.map(key));
  const missing = [...want].filter((k) => !have.has(k));
  const extra = [...have].filter((k) => !want.has(k));
  return { ok: !missing.length && !extra.length, missing, extra };
}
