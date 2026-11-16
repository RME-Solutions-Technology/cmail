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
 *
 * The record is read with a small RFC 8601 parser (parseResinfos, below)
 * rather than by searching the text: a quoted value is always one value, so
 * text inside one (`smtp.mailfrom="x dmarc=pass"`, `reason="k header.d=t"`)
 * can never be read as a verdict or a property. It degrades gracefully on
 * harmless malformations (an empty value, an unquoted multi-word reason, a
 * missing `;`, a quoted local part, a quote inside a comment): the leading
 * `method=result` of a resinfo is always read, every property before the
 * first malformed point is kept, and only the rest of that resinfo is lost.
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
 * comments belong to the record and must not split it. Inside a comment a
 * quote is ordinary text (RFC 5322 3.2.2), so it never opens a quoted string.
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
    if (depth > 0) {
      if (char === '\\') index += 1;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '(') depth = 1;
    else if (char === ',') return value.slice(0, index);
  }
  return value;
}

/**
 * Strip RFC 5322 comments, which may appear between any two tokens. A quote
 * inside a comment is ordinary text and a backslash escapes the next
 * character, so neither can leak out of the comment.
 */
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
    if (depth > 0) {
      if (char === '\\') index += 1;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      // A comment separates tokens like a space does.
      if (depth === 0) out += ' ';
      continue;
    }
    if (char === '"') { quoted = true; out += char; }
    else if (char === '(') depth = 1;
    else out += char;
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
  /** Unquoted value, case kept; '' for an empty value. */
  value: string;
}

interface Resinfo {
  /** Lower-case method, version dropped (`dkim/1` is `dkim`); '' for a segment of properties only. */
  method: string;
  /** Lower-case result; '' when the method had no plain-word result. */
  result: string;
  properties: ResinfoProperty[];
}

const NAME_CHAR = /[A-Za-z0-9._/-]/;
const SPACE = /\s/;

/**
 * Reads the resinfos of one record (comments already removed, authserv-id
 * already cut off), RFC 8601 §2.2: `method=result` then `reason=value` and
 * `ptype.property=value` pairs, `;` between resinfos.
 *
 * - A value is a run of unquoted text and quoted strings with no space
 *   between them (`"john doe"@example.com` is one value). Quoted text is
 *   always part of the value it is in, never a token of its own.
 * - `name=` followed by space and another `name=` is an empty value.
 * - A `name=value` whose name has no dot and is not `reason` starts a new
 *   resinfo, even without a `;` before it (a method token at top level).
 * - The first malformed point (a stray word, a lone `=`) ends the resinfo
 *   for this parse: everything before it is kept, the rest up to the next
 *   `;` is skipped. An unterminated quote does the same; the parse resumes
 *   after the next `;`.
 */
function parseResinfos(body: string): Resinfo[] {
  const out: Resinfo[] = [];
  let current: Resinfo | null = null;
  let index = 0;
  const length = body.length;
  const skipSpace = () => {
    while (index < length && SPACE.test(body[index] as string)) index += 1;
  };
  const skipToSeparator = () => {
    const next = body.indexOf(';', index);
    index = next < 0 ? length : next;
  };

  while (index < length) {
    skipSpace();
    if (index >= length) break;
    if (body[index] === ';') {
      index += 1;
      current = null;
      continue;
    }
    const nameStart = index;
    while (index < length && NAME_CHAR.test(body[index] as string)) index += 1;
    const name = body.slice(nameStart, index);
    skipSpace();
    if (!name || body[index] !== '=') {
      // A stray word or character: this resinfo ends here.
      skipToSeparator();
      continue;
    }
    index += 1;

    // Empty value: `name=` then space then another `name=` (or the end, or `;`).
    const afterEquals = index;
    skipSpace();
    let empty = index >= length || body[index] === ';';
    if (!empty && index > afterEquals) {
      let peek = index;
      while (peek < length && NAME_CHAR.test(body[peek] as string)) peek += 1;
      let peekAfter = peek;
      while (peekAfter < length && SPACE.test(body[peekAfter] as string)) peekAfter += 1;
      empty = peek > index && body[peekAfter] === '=';
    }

    let value = '';
    let quotedAny = false;
    let unterminated = false;
    let quoteStart = -1;
    if (!empty) {
      while (index < length && !SPACE.test(body[index] as string) && body[index] !== ';') {
        if (body[index] === '"') {
          quotedAny = true;
          quoteStart = index;
          index += 1;
          let closed = false;
          while (index < length) {
            const char = body[index] as string;
            if (char === '\\' && index + 1 < length) {
              value += body[index + 1];
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
          if (!closed) {
            unterminated = true;
            break;
          }
        } else {
          value += body[index];
          index += 1;
        }
      }
    }
    if (unterminated) {
      // The quote never closes: this value and the rest of the resinfo are
      // not read. The parse resumes at the next `;` after the quote's start.
      const next = body.indexOf(';', quoteStart);
      index = next < 0 ? length : next;
      continue;
    }

    const lowerName = name.toLowerCase();
    const isMethod = !lowerName.includes('.') && lowerName !== 'reason';
    if (isMethod) {
      const plainResult = !quotedAny && /^[a-z]+$/i.test(value);
      current = {
        method: lowerName.replace(/\/[0-9]+$/, ''),
        result: plainResult ? value.toLowerCase() : '',
        properties: [],
      };
      out.push(current);
      continue;
    }
    if (!current) {
      current = { method: '', result: '', properties: [] };
      out.push(current);
    }
    current.properties.push({ name: lowerName, value });
  }
  return out;
}

/** The trusted record's resinfos, or null when it is not the trusted boundary's. */
function trustedResinfos(headerValue: string | null | undefined, trustedAuthservId: string | null | undefined): Resinfo[] | null {
  const trusted = (trustedAuthservId || '').trim().toLowerCase();
  const raw = (headerValue || '').trim();
  // Bound the input: a header line is 998 octets, and folding a handful of
  // records cannot legitimately exceed this.
  if (!trusted || !raw || raw.length > 4096) return null;

  const record = stripComments(firstRecord(raw)).trim();
  const separator = record.indexOf(';');
  if (separator < 0) return null;

  // authserv-id, optionally followed by a version number (RFC 8601 §2.2).
  const identifier = record.slice(0, separator).trim().split(/\s+/)[0] || '';
  if (identifier.toLowerCase() !== trusted) return null;
  return parseResinfos(record.slice(separator + 1));
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
  const resinfos = trustedResinfos(headerValue, trustedAuthservId);
  if (!resinfos) return { ...NO_FACTS };
  const facts: AuthenticationFacts = { ...NO_FACTS };

  for (const method of METHODS) {
    // First occurrence wins. Only a resinfo's own leading `method=result`
    // counts: text inside a quoted value is never read as one.
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
  /** SPF verdict of the first `spf=` result in the trusted record. */
  spf: string | null;
  /**
   * Lower-case domain of that result's `smtp.mailfrom` (the envelope MAIL
   * FROM the SPF verdict is about); 'invalid' when it is not a whole domain;
   * null when the boundary wrote none.
   */
  spfMailFromDomain: string | 'invalid' | null;
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
  const resinfos = trustedResinfos(headerValue, trustedAuthservId);
  if (!resinfos) return { dmarc: facts.dmarc, dkimPassDomains: [], dmarcHeaderFrom: null, spf: facts.spf, spfMailFromDomain: null };
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
  let spfMailFromDomain: AuthenticationIdentities['spfMailFromDomain'] = null;
  const spf = resinfos.find((info) => info.method === 'spf');
  const mailFrom = spf?.properties.find((property) => property.name === 'smtp.mailfrom');
  if (mailFrom) {
    // smtp.mailfrom is an address or, for an empty MAIL FROM, a domain (HELO).
    const at = mailFrom.value.lastIndexOf('@');
    const value = (at >= 0 ? mailFrom.value.slice(at + 1) : mailFrom.value).toLowerCase().replace(/\.$/, '');
    spfMailFromDomain = DKIM_DOMAIN.test(value) ? value : 'invalid';
  }
  return { dmarc: facts.dmarc, dkimPassDomains: [...domains], dmarcHeaderFrom, spf: facts.spf, spfMailFromDomain };
}
