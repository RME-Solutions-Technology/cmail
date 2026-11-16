// A safe diagnostic for a refused journal report (docs/exchange-mirror.md,
// "Diagnosing refused reports"). Written to the audit log so a manager can
// see which tenant and authentication headers a real report carried, without
// storing mail content or anything a sender wrote.
//
// It holds ONLY, from the OUTER report:
// - headers on an exact allowlist, each value kept only when it has the
//   shape that header should have (a GUID, a date, a short token); any other
//   value is replaced by its length ("<hidden, 37 chars>");
// - for Authentication-Results: the authserv-id and, per result, the method,
//   the verdict and the DOMAIN it was about (header.d, header.from,
//   smtp.mailfrom), each only if it is a valid domain. Never a local part, a
//   display name, a reason or any other text;
// - for DKIM-Signature: d= and s= only, each only if domain/token shaped;
// and from the attached original: how many headers it has with those names.
// Never a subject, an address, a body or another header. Bounded in size.

type Header = { key: string; value: string };

type Shape = 'flag' | 'guid' | 'date' | 'token';

/** The only headers ever recorded, and the shape each value must have. */
const ALLOWED: ReadonlyMap<string, Shape> = new Map([
  ['x-ms-journal-report', 'flag'],
  ['x-ms-exchange-crosstenant-id', 'guid'],
  ['x-ms-exchange-crosstenant-network-message-id', 'guid'],
  ['x-ms-exchange-crosstenant-authas', 'token'],
  ['x-ms-exchange-crosstenant-authsource', 'token'],
  ['x-ms-exchange-crosstenant-fromentityheader', 'token'],
  ['x-ms-exchange-crosstenant-mailboxtype', 'token'],
  ['x-ms-exchange-crosstenant-originalarrivaltime', 'date'],
  ['x-ms-exchange-organization-network-message-id', 'guid'],
  ['x-ms-exchange-organization-authas', 'token'],
  ['x-ms-exchange-organization-authsource', 'token'],
  ['x-ms-exchange-organization-scl', 'token'],
  ['authentication-results', 'token'],
  ['dkim-signature', 'token'],
]);

const SHAPES: Readonly<Record<Shape, RegExp>> = {
  flag: /^$/,
  guid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // "16 Nov 2026 01:02:03.0000 (UTC)"
  date: /^[0-9]{1,2} [A-Za-z]{3} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,7})?(?: \([A-Z]{1,5}\))?$/,
  token: /^[A-Za-z0-9._-]{1,64}$/,
};

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const METHOD = /^[a-z0-9-]{1,20}$/;
const RESULT = /^[a-z]{1,12}$/;
const MAX_ENTRIES = 30;
const MAX_RESULTS = 10;
export const MAX_DIAGNOSTIC = 3000;

function hidden(value: string): string {
  return `<hidden, ${Math.min(value.length, 99_999)} chars>`;
}

function domainOnly(value: string | undefined): string | null {
  if (!value) return null;
  const at = value.lastIndexOf('@');
  const domain = (at >= 0 ? value.slice(at + 1) : value).trim().toLowerCase().replace(/\.$/, '');
  return DOMAIN.test(domain) ? domain : null;
}

/**
 * The structure of one Authentication-Results value: authserv-id, then per
 * result `method=verdict` and the domains it names. Read with a small
 * splitter (quoted strings and comments are skipped, never copied), so no
 * free text can come through.
 */
function authResultsSummary(value: string): string {
  // Drop comments and quoted strings first: nothing inside them is kept.
  let text = '';
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length && index < 4096; index += 1) {
    const char = value[index] as string;
    if (quoted) {
      if (char === '\\') index += 1;
      else if (char === '"') { quoted = false; text += '""'; }
      continue;
    }
    if (depth > 0) {
      if (char === '\\') index += 1;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '(') { depth = 1; text += ' '; }
    else text += char;
  }
  const [head = '', ...results] = text.split(';');
  const authserv = (head.trim().split(/\s+/)[0] ?? '').toLowerCase();
  const parts = [`authserv=${DOMAIN.test(authserv) ? authserv : hidden(authserv)}`];
  for (const result of results.slice(0, MAX_RESULTS)) {
    const pairs = result.trim().split(/\s+/).map((pair) => {
      const equals = pair.indexOf('=');
      return equals > 0 ? [pair.slice(0, equals).toLowerCase(), pair.slice(equals + 1)] as const : null;
    }).filter((pair): pair is readonly [string, string] => pair !== null);
    const first = pairs[0];
    if (!first || !METHOD.test(first[0]) || !RESULT.test(first[1].toLowerCase())) continue;
    const kept = [`${first[0]}=${first[1].toLowerCase()}`];
    for (const [name, raw] of pairs.slice(1)) {
      if (name !== 'header.d' && name !== 'header.from' && name !== 'smtp.mailfrom' && name !== 'header.i') continue;
      const domain = domainOnly(raw);
      kept.push(`${name}=${domain ?? '<hidden>'}`);
    }
    parts.push(kept.join(' '));
  }
  return parts.join('; ');
}

function dkimTags(value: string): string {
  const tag = (name: string) => new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;\\s]{0,253})`, 'i').exec(value)?.[1] ?? '';
  const d = tag('d').toLowerCase();
  const s = tag('s');
  return `d=${DOMAIN.test(d) ? d : '<hidden>'} s=${SHAPES.token.test(s) ? s : '<hidden>'}`;
}

function shown(name: string, value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (name === 'authentication-results') return authResultsSummary(value);
  if (name === 'dkim-signature') return dkimTags(value);
  const shape = ALLOWED.get(name) as Shape;
  return SHAPES[shape].test(trimmed) ? trimmed : hidden(trimmed);
}

/** Number of header fields with an allowlisted name in a raw message's header block. */
export function countOriginalHeaders(raw: Uint8Array | null): number {
  if (!raw) return 0;
  const limit = Math.min(raw.byteLength, 512 * 1024);
  let count = 0;
  let lineStart = 0;
  for (let index = 0; index <= limit; index += 1) {
    if (index < limit && raw[index] !== 0x0a) continue;
    let end = index;
    if (end > lineStart && raw[end - 1] === 0x0d) end -= 1;
    if (end === lineStart) break; // empty line: end of the header block
    const first = raw[lineStart];
    if (first !== 0x20 && first !== 0x09) {
      let name = '';
      for (let at = lineStart; at < end && at - lineStart < 80; at += 1) {
        const char = raw[at] as number;
        if (char === 0x3a) break;
        name += String.fromCharCode(char);
      }
      if (ALLOWED.has(name.trim().toLowerCase())) count += 1;
    }
    lineStart = index + 1;
  }
  return count;
}

export function journalDiagnostic(outerHeaders: readonly Header[] | undefined, originalRaw: Uint8Array | null): string {
  const entries: string[] = [];
  for (const header of outerHeaders ?? []) {
    const name = header.key.trim().toLowerCase();
    if (!ALLOWED.has(name)) continue;
    if (entries.length >= MAX_ENTRIES) {
      entries.push('…');
      break;
    }
    entries.push(`${name}: ${shown(name, header.value ?? '')}`);
  }
  const text = `outer headers: ${entries.length ? entries.join(' | ') : 'none of interest'}; original: ${countOriginalHeaders(originalRaw)} such headers`;
  return text.length > MAX_DIAGNOSTIC ? `${text.slice(0, MAX_DIAGNOSTIC - 1)}…` : text;
}
