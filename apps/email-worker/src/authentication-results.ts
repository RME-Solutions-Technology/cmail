/**
 * RFC 8601 Authentication-Results parsing, gated on a trusted boundary.
 *
 * An Authentication-Results header is only meaningful if you can attribute it
 * to an MTA you trust. Any sender can put `spf=pass` in a message. RFC 8601
 * §5 is explicit: a consumer must ignore results whose authserv-id is not its
 * own trusted identifier.
 *
 * So this module refuses to produce a verdict unless the operator has named
 * the boundary via INBOUND_AUTHSERV_ID, and the topmost record actually came
 * from it. With no configuration the behaviour is identical to recording
 * nothing, which is the safe default.
 *
 * Only the topmost record is considered. Workers joins repeated headers with
 * ", ", and the most recently added header — the one written by the boundary
 * closest to us — appears first. Anything after it was added further out and
 * is not ours to trust.
 */

export interface AuthenticationFacts {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  /** The boundary's ARC verdict, if it published one. Not our own validation. */
  arc: string | null;
  sourceIp: string | null;
}

export const NO_FACTS: AuthenticationFacts = {
  spf: null,
  dkim: null,
  dmarc: null,
  arc: null,
  sourceIp: null,
};

/** The RFC 8601 result values we accept. Anything else is discarded. */
const RESULTS = new Set([
  'none', 'pass', 'fail', 'softfail', 'neutral', 'temperror', 'permerror', 'policy',
]);

const METHODS = ['spf', 'dkim', 'dmarc', 'arc'] as const;
type Method = (typeof METHODS)[number];

/**
 * Cut the joined header value at the first top-level comma, so only the
 * topmost record is examined. Commas inside quoted strings and inside RFC 5322
 * comments belong to the record and must not split it.
 */
function firstRecord(value: string): string {
  let quoted = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (char === '\\') index += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) return value.slice(0, index);
  }
  return value;
}

/** Strip RFC 5322 comments, which may appear between any two tokens. */
function stripComments(value: string): string {
  let out = '';
  let quoted = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      out += char;
      if (char === '\\' && index + 1 < value.length) { out += value[index + 1]; index += 1; }
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; out += char; }
    else if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += char;
  }
  return out;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return trimmed;
}

/** Accepts dotted-quad IPv4 and the common IPv6 forms, nothing else. */
function safeIp(value: string): string | null {
  const candidate = unquote(value);
  if (!candidate || candidate.length > 45) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate)) {
    return candidate.split('.').every((part) => Number(part) <= 255) ? candidate : null;
  }
  if (/^[0-9a-f:]{2,45}$/i.test(candidate) && candidate.includes(':')) return candidate.toLowerCase();
  return null;
}

const IP_PROPERTIES = new Set(['smtp.remote-ip', 'policy.iprev', 'policy.client-ip']);

interface ResinfoProperty {
  /** Lower-case `ptype.property`, or `reason`. */
  name: string;
  /** Unquoted value, case kept. */
  value: string;
}

interface Resinfo {
  /** Lower-case method, version dropped (`dkim/1` is `dkim`). */
  method: string;
  /** Lower-case result. */
  result: string;
  properties: ResinfoProperty[];
}

/**
 * Tokenizes the resinfo list of one record (comments already removed) per
 * RFC 8601 §2.2: `;`-separated resinfos, each `method=result`, then an
 * optional `reason=value` and `ptype.property=value` pairs, where a value is
 * a token or a quoted string. Quoted strings are read whole, so text inside
 * one (`smtp.mailfrom="x dmarc=pass"`, `reason="k header.d=tenant"`) is only
 * ever that property's value. A resinfo that does not tokenize (unclosed
 * quote, stray text) is dropped whole rather than half-read.
 */
function parseResinfos(body: string): Resinfo[] {
  const out: Resinfo[] = [];
  for (const segment of resultSegments(body)) {
    const pairs = tokenizePairs(segment);
    if (!pairs || !pairs.length) continue;
    const [first, ...rest] = pairs;
    if (!first || !/^[a-z0-9-]+(?:\/[0-9]+)?$/i.test(first.name) || !/^[a-z]+$/i.test(first.value) || first.quoted) continue;
    out.push({
      method: first.name.toLowerCase().replace(/\/[0-9]+$/, ''),
      result: first.value.toLowerCase(),
      properties: rest.map((pair) => ({ name: pair.name.toLowerCase(), value: pair.value })),
    });
  }
  return out;
}

/** `name = value` pairs of one resinfo, or null if anything else is there. */
function tokenizePairs(segment: string): Array<{ name: string; value: string; quoted: boolean }> | null {
  const pairs: Array<{ name: string; value: string; quoted: boolean }> = [];
  const text = segment;
  let index = 0;
  const skipSpace = () => {
    while (index < text.length && /\s/.test(text[index] as string)) index += 1;
  };
  skipSpace();
  while (index < text.length) {
    const nameStart = index;
    while (index < text.length && /[A-Za-z0-9._\/-]/.test(text[index] as string)) index += 1;
    const name = text.slice(nameStart, index);
    if (!name) return null;
    skipSpace();
    if (text[index] !== '=') return null;
    index += 1;
    skipSpace();
    let value = '';
    let quoted = false;
    if (text[index] === '"') {
      quoted = true;
      index += 1;
      let closed = false;
      while (index < text.length) {
        const char = text[index] as string;
        if (char === '\\' && index + 1 < text.length) {
          value += text[index + 1];
          index += 2;
        } else if (char === '"') {
          index += 1;
          closed = true;
          break;
        } else {
          value += char;
          index += 1;
        }
      }
      if (!closed) return null;
    } else {
      const valueStart = index;
      while (index < text.length && !/[\s";]/.test(text[index] as string)) index += 1;
      value = text.slice(valueStart, index);
      if (!value) return null;
    }
    pairs.push({ name, value, quoted });
    const before = index;
    skipSpace();
    // Two pairs must be separated by space.
    if (index < text.length && index === before) return null;
  }
  return pairs;
}

/**
 * @param headerValue The raw Authentication-Results header, or null.
 * @param trustedAuthservId The operator's boundary identifier. Empty disables
 *   parsing entirely and yields no facts.
 */
export function parseAuthenticationResults(
  headerValue: string | null | undefined,
  trustedAuthservId: string | null | undefined,
): AuthenticationFacts {
  const trusted = (trustedAuthservId || '').trim().toLowerCase();
  const raw = (headerValue || '').trim();
  // Bound the input: a header line is 998 octets, and folding a handful of
  // records cannot legitimately exceed this.
  if (!trusted || !raw || raw.length > 4096) return { ...NO_FACTS };

  const record = stripComments(firstRecord(raw)).trim();
  const separator = record.indexOf(';');
  if (separator < 0) return { ...NO_FACTS };

  // authserv-id, optionally followed by a version number (RFC 8601 §2.2).
  const identifier = record.slice(0, separator).trim().split(/\s+/)[0] || '';
  if (identifier.toLowerCase() !== trusted) return { ...NO_FACTS };

  const facts: AuthenticationFacts = { ...NO_FACTS };
  const resinfos = parseResinfos(record.slice(separator + 1));

  for (const method of METHODS) {
    // First occurrence wins. Only a resinfo's own leading `method=result`
    // counts: text inside a quoted property value is never read as one.
    const info = resinfos.find((item) => item.method === method);
    if (info && RESULTS.has(info.result)) facts[method as Method] = info.result;
  }

  // Some boundaries publish the connecting address as a property. Take it only
  // from the record we already decided to trust.
  for (const info of resinfos) {
    const ip = info.properties.find((property) => IP_PROPERTIES.has(property.name));
    if (ip) {
      facts.sourceIp = safeIp(ip.value);
      break;
    }
  }

  return facts;
}

export interface AuthenticationIdentities {
  /** DMARC verdict of the trusted record, as in parseAuthenticationResults. */
  dmarc: string | null;
  /** Lower-case `header.d` (or the domain of `header.i`) of every `dkim=pass` in the trusted record. */
  dkimPassDomains: string[];
  /**
   * `header.from` of the first `dmarc=` result in the trusted record:
   * the lower-case domain; 'invalid' when the boundary wrote a value that is
   * not a whole domain (never treated as absent); null when it wrote none.
   */
  dmarcHeaderFrom: string | 'invalid' | null;
}

/** Split on `;` outside quoted strings (comments are already stripped). */
function resultSegments(body: string): string[] {
  const segments: string[] = [];
  let quoted = false;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '\\') index += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ';') {
      segments.push(body.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(body.slice(start));
  return segments;
}

const DKIM_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Which domains passed DKIM, from the same trusted record (and the same
 * trust rule) as parseAuthenticationResults. Used by the Exchange mirror to
 * tie a journal report to the tenant's own domains. Returns nothing unless
 * the topmost record's authserv-id is the configured one.
 */
export function parseAuthenticationIdentities(
  headerValue: string | null | undefined,
  trustedAuthservId: string | null | undefined,
): AuthenticationIdentities {
  const facts = parseAuthenticationResults(headerValue, trustedAuthservId);
  const none: AuthenticationIdentities = { dmarc: facts.dmarc, dkimPassDomains: [], dmarcHeaderFrom: null };
  const trusted = (trustedAuthservId || '').trim().toLowerCase();
  const raw = (headerValue || '').trim();
  if (!trusted || !raw || raw.length > 4096) return none;
  const record = stripComments(firstRecord(raw)).trim();
  const separator = record.indexOf(';');
  if (separator < 0) return none;
  const identifier = record.slice(0, separator).trim().split(/\s+/)[0] || '';
  if (identifier.toLowerCase() !== trusted) return none;

  const resinfos = parseResinfos(record.slice(separator + 1));
  const domains = new Set<string>();
  for (const info of resinfos) {
    if (info.method !== 'dkim' || info.result !== 'pass') continue;
    // header.d when present (an invalid one is not replaced by header.i).
    const d = info.properties.find((property) => property.name === 'header.d');
    const i = info.properties.find((property) => property.name === 'header.i');
    const domain = (d ? d.value : (i?.value.split('@').pop() ?? '')).toLowerCase().replace(/\.$/, '');
    if (DKIM_DOMAIN.test(domain)) domains.add(domain);
  }
  let dmarcHeaderFrom: AuthenticationIdentities['dmarcHeaderFrom'] = null;
  const dmarc = resinfos.find((info) => info.method === 'dmarc');
  const from = dmarc?.properties.find((property) => property.name === 'header.from');
  if (from) {
    const value = from.value.toLowerCase().replace(/\.$/, '');
    dmarcHeaderFrom = DKIM_DOMAIN.test(value) ? value : 'invalid';
  }
  return { dmarc: facts.dmarc, dkimPassDomains: [...domains], dmarcHeaderFrom };
}
