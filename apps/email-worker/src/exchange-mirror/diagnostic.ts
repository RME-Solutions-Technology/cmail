// A safe diagnostic for a refused journal report (docs/exchange-mirror.md,
// "Diagnosing refused reports"). Written to the audit log so a manager can
// see which tenant and authentication headers a real report carried, without
// storing mail content.
//
// It holds ONLY:
// - from the OUTER report's own headers: the names and values of
//   X-MS-Exchange-CrossTenant-*, X-MS-Exchange-Organization-*,
//   X-MS-Journal-Report and Authentication-Results, with every email address
//   cut down to its domain (`user@example.com` becomes `@example.com`), and
//   for DKIM-Signature only its d= and s= tags;
// - from the attached original: how many headers with those names it has
//   (a count, nothing else).
// Never a subject, an address, a body or another header. Bounded in size.

type Header = { key: string; value: string };

const NAMES = /^(?:x-ms-exchange-crosstenant-[a-z0-9-]+|x-ms-exchange-organization-[a-z0-9-]+|x-ms-journal-report|authentication-results|dkim-signature)$/;
// The local part of an address: what comes before '@' back to a delimiter
// ('=' too, so `smtp.mailfrom=user@example.com` keeps its property name).
const ADDRESS_LOCAL = /[^\s<>"'(),;:=@[\]\\]+@/g;
const MAX_ENTRIES = 30;
const MAX_VALUE = 200;
export const MAX_DIAGNOSTIC = 3000;

function dkimTags(value: string): string {
  const tag = (name: string) => new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;\\s]{0,253})`, 'i').exec(value)?.[1] ?? '';
  const d = tag('d').toLowerCase();
  const s = tag('s');
  return `d=${/^[a-z0-9.-]*$/.test(d) ? d : '?'} s=${/^[A-Za-z0-9._-]*$/.test(s) ? s : '?'}`;
}

function clean(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(ADDRESS_LOCAL, '@')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_VALUE);
}

/** Number of header fields named like NAMES in a raw message's header block. */
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
      if (NAMES.test(name.trim().toLowerCase())) count += 1;
    }
    lineStart = index + 1;
  }
  return count;
}

export function journalDiagnostic(outerHeaders: readonly Header[] | undefined, originalRaw: Uint8Array | null): string {
  const entries: string[] = [];
  for (const header of outerHeaders ?? []) {
    const name = header.key.trim().toLowerCase();
    if (!NAMES.test(name)) continue;
    if (entries.length >= MAX_ENTRIES) {
      entries.push('…');
      break;
    }
    entries.push(`${name}: ${name === 'dkim-signature' ? dkimTags(header.value ?? '') : clean(header.value ?? '')}`);
  }
  const text = `outer headers: ${entries.length ? entries.join(' | ') : 'none of interest'}; original: ${countOriginalHeaders(originalRaw)} such headers`;
  return text.slice(0, MAX_DIAGNOSTIC);
}
