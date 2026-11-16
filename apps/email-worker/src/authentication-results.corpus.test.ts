import { describe, expect, it } from 'vitest';
import { parseAuthenticationIdentities, parseAuthenticationResults, type AuthenticationFacts } from './authentication-results';

// A corpus for the Authentication-Results parser, which every inbound
// delivery uses. Three groups:
// 1. Well-formed records parse exactly as the previous (regex) parser did.
// 2. Harmless malformations degrade gracefully: the leading verdicts and the
//    properties before the malformed point are still read.
// 3. Injection inputs (text inside a quoted value) never become a verdict,
//    a DKIM domain or a header.from.

const ID = 'mx.cloudflare.net';

/** The parser as it was on main before the Exchange mirror (908ad85), kept here only for comparison. */
function legacyParse(headerValue: string, trusted: string): AuthenticationFacts {
  const NONE: AuthenticationFacts = { spf: null, dkim: null, dmarc: null, arc: null, sourceIp: null };
  const RESULTS = new Set(['none', 'pass', 'fail', 'softfail', 'neutral', 'temperror', 'permerror', 'policy']);
  const firstRecord = (value: string) => {
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
  };
  const stripComments = (value: string) => {
    let out = '';
    let quoted = false;
    let depth = 0;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (quoted) {
        out += char;
        if (char === '\\' && index + 1 < value.length) { out += value[index + 1]; index += 1; } else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; out += char; } else if (char === '(') depth += 1;
      else if (char === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0) out += char;
    }
    return out;
  };
  const unquote = (value: string) => {
    const trimmed = value.trim();
    return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).replace(/\\(.)/g, '$1') : trimmed;
  };
  const safeIp = (value: string) => {
    const candidate = unquote(value);
    if (!candidate || candidate.length > 45) return null;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate)) return candidate.split('.').every((part) => Number(part) <= 255) ? candidate : null;
    if (/^[0-9a-f:]{2,45}$/i.test(candidate) && candidate.includes(':')) return candidate.toLowerCase();
    return null;
  };
  const raw = headerValue.trim();
  if (!trusted || !raw || raw.length > 4096) return { ...NONE };
  const record = stripComments(firstRecord(raw)).trim();
  const separator = record.indexOf(';');
  if (separator < 0) return { ...NONE };
  if ((record.slice(0, separator).trim().split(/\s+/)[0] || '').toLowerCase() !== trusted.toLowerCase()) return { ...NONE };
  const facts: AuthenticationFacts = { ...NONE };
  const body = record.slice(separator + 1);
  for (const method of ['spf', 'dkim', 'dmarc', 'arc'] as const) {
    const match = new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([A-Za-z]+)`, 'i').exec(body);
    if (!match) continue;
    const result = (match[1] || '').toLowerCase();
    if (RESULTS.has(result)) facts[method] = result;
  }
  const ip = /(?:smtp\.remote-ip|policy\.iprev|policy\.client-ip)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s;]+)/i.exec(body);
  if (ip?.[1]) facts.sourceIp = safeIp(ip[1]);
  return facts;
}

const WELL_FORMED = [
  // Cloudflare Email Routing, as documented and as seen in tests.
  'mx.cloudflare.net; dkim=pass header.d=example.com header.s=sel1 header.b=AbCd; dmarc=fail reason="SPF/DKIM not aligned" header.from=example.org policy.dmarc=reject; spf=pass (mx.cloudflare.net: domain of sender@example.com designates 192.0.2.10 as permitted sender) smtp.mailfrom=sender@example.com; arc=none smtp.remote-ip=192.0.2.10',
  'mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass',
  'mx.cloudflare.net; dkim=pass header.d=example.com header.s=selector1 header.b=Ab+Cd/Ef==; dkim=pass header.d=example.onmicrosoft.com header.s=selector2 header.b=Gh==; arc=pass; dmarc=pass header.from=example.com policy.dmarc=none; spf=pass smtp.mailfrom=bounce@example.com',
  'mx.cloudflare.net 1; spf=softfail smtp.mailfrom=x@example.net; dkim=none; dmarc=none header.from=example.net',
  'MX.CLOUDFLARE.NET; SPF=PASS smtp.mailfrom=a@example.com; DKIM=FAIL reason="signature verification failed" header.d=example.com; DMARC=PASS',
  'mx.cloudflare.net; spf=pass policy.iprev="2001:DB8::1"; dkim=pass header.i=@example.com',
  'mx.cloudflare.net; dkim = pass header.d = example.com; spf = neutral',
  'mx.cloudflare.net; dkim-atps=pass; dkim=temperror',
  'mx.cloudflare.net; none',
  'mx.cloudflare.net; spf=pass smtp.mailfrom=a@example.com, mx.cloudflare.net; dkim=pass; dmarc=pass',
];

describe('well-formed records parse exactly as before', () => {
  for (const record of WELL_FORMED) {
    it(record.slice(0, 80), () => {
      expect(parseAuthenticationResults(record, ID)).toEqual(legacyParse(record, ID));
    });
  }

  it('reads the full Cloudflare-shaped record', () => {
    expect(parseAuthenticationResults(WELL_FORMED[0] as string, ID)).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'fail', arc: 'none', sourceIp: '192.0.2.10' });
    expect(parseAuthenticationIdentities(WELL_FORMED[2] as string, ID)).toEqual({
      dmarc: 'pass',
      dkimPassDomains: ['example.com', 'example.onmicrosoft.com'],
      dmarcHeaderFrom: 'example.com',
      spf: 'pass',
      spfMailFromDomain: 'example.com',
    });
  });
});

describe('harmless malformations degrade gracefully', () => {
  const cases: Array<{ name: string; record: string; facts: Partial<AuthenticationFacts>; dkimDomains?: string[]; headerFrom?: string | 'invalid' | null }> = [
    {
      name: 'empty value',
      record: `${ID}; dmarc=pass policy.dmarc= header.from=example.com; spf=pass smtp.remote-ip=192.0.2.1`,
      facts: { dmarc: 'pass', spf: 'pass', sourceIp: '192.0.2.1' },
      headerFrom: 'example.com',
    },
    {
      name: 'empty value at the end of a resinfo',
      record: `${ID}; dmarc=pass policy.dmarc=; spf=pass`,
      facts: { dmarc: 'pass', spf: 'pass' },
    },
    {
      name: 'unquoted multi-word reason keeps the verdict and the next resinfo',
      record: `${ID}; dkim=fail reason=local policy applied header.d=example.com; dmarc=pass; spf=pass smtp.remote-ip=192.0.2.2`,
      facts: { dkim: 'fail', dmarc: 'pass', spf: 'pass', sourceIp: '192.0.2.2' },
    },
    {
      name: 'missing ; between results',
      record: `${ID}; spf=pass smtp.mailfrom=a@example.com dkim=pass header.d=example.com dmarc=pass header.from=example.com`,
      facts: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      dkimDomains: ['example.com'],
      headerFrom: 'example.com',
    },
    {
      name: 'quoted local part',
      record: `${ID}; spf=pass smtp.mailfrom="john doe"@b.example smtp.remote-ip=192.0.2.3; dkim=pass header.d=b.example`,
      facts: { spf: 'pass', dkim: 'pass', sourceIp: '192.0.2.3' },
      dkimDomains: ['b.example'],
    },
    {
      name: 'a lone quote inside a comment',
      record: `${ID}; spf=pass (the "sender) smtp.mailfrom=a@example.com; dkim=pass header.d=example.com; dmarc=pass`,
      facts: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      dkimDomains: ['example.com'],
    },
    {
      name: 'a property-only segment keeps the source address',
      record: `${ID}; spf=pass; smtp.remote-ip=192.0.2.4; dkim=pass`,
      facts: { spf: 'pass', dkim: 'pass', sourceIp: '192.0.2.4' },
    },
    {
      name: 'an unterminated quote ends that resinfo only',
      record: `${ID}; spf=pass smtp.mailfrom="open; dkim=pass header.d=example.com`,
      facts: { spf: 'pass', dkim: 'pass' },
    },
  ];
  for (const item of cases) {
    it(item.name, () => {
      const facts = parseAuthenticationResults(item.record, ID);
      expect(facts).toMatchObject(item.facts);
      const identities = parseAuthenticationIdentities(item.record, ID);
      if (item.dkimDomains) expect(identities.dkimPassDomains).toEqual(item.dkimDomains);
      if (item.headerFrom !== undefined) expect(identities.dmarcHeaderFrom).toBe(item.headerFrom);
    });
  }
});

describe('injection inputs never become a verdict or a domain', () => {
  it('a verdict inside a quoted value', () => {
    for (const record of [
      `${ID}; spf=pass smtp.mailfrom="x dmarc=pass"`,
      `${ID}; spf=pass smtp.mailfrom="x; dmarc=pass"`,
      `${ID}; spf=pass smtp.mailfrom=a"b dmarc=pass"`,
      `${ID}; spf=pass reason="dkim=pass"`,
      `${ID}; spf=pass (dmarc=pass) smtp.mailfrom=a@example.com`,
      `${ID}; spf=pass (a "quote dmarc=pass) smtp.mailfrom=a@example.com`,
    ]) {
      const facts = parseAuthenticationResults(record, ID);
      expect(facts.dmarc, record).toBeNull();
      expect(facts.dkim, record).toBeNull();
    }
  });

  it('a header.d inside a quoted reason or a comment', () => {
    for (const record of [
      `${ID}; dkim=pass reason="k header.d=tenant"`,
      `${ID}; dkim=pass reason="k header.d=example.test"`,
      `${ID}; dkim=pass (header.d=example.test)`,
      `${ID}; dkim=pass reason="open header.d=example.test`,
    ]) {
      expect(parseAuthenticationIdentities(record, ID).dkimPassDomains, record).toEqual([]);
    }
  });

  it('a header.from that is not a whole domain is invalid, not absent', () => {
    for (const value of ['evil.example_', 'example.test_.evil.example', '"a b"', '']) {
      expect(parseAuthenticationIdentities(`${ID}; dmarc=pass header.from=${value}`, ID).dmarcHeaderFrom, value).toBe('invalid');
    }
  });

  it('a record below the trusted one, or from another boundary', () => {
    expect(parseAuthenticationResults(`mx.attacker.example; dmarc=pass`, ID).dmarc).toBeNull();
    expect(parseAuthenticationResults(`${ID}; dmarc=fail, ${ID}; dmarc=pass`, ID).dmarc).toBe('fail');
    // A comma and a quote inside a comment do not end the trusted record early.
    expect(parseAuthenticationResults(`${ID}; spf=pass (a, "b) dmarc=fail, ${ID}; dmarc=pass`, ID).dmarc).toBe('fail');
  });
});
