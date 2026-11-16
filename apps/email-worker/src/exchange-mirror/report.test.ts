import { describe, expect, it } from 'vitest';
import { parseAuthenticationIdentities, parseAuthenticationResults } from '../authentication-results';
import { exchangeMirrorConfig, isJournalAddress, maskJournalAddress } from '@cmail/shared/exchange-mirror';
import { attachedOriginal, envelopeAddress, envelopeText, MAX_JOURNAL_RECIPIENTS, parseJournalEnvelope } from './report';
import { fromDomain, headerBlockWellFormed, headerValues, verifyJournalReport } from './verify';
import { sentCopyAllowed } from './ingest';
import { JOURNAL, TENANT } from './fixtures';

const HEAD = ['Sender: alice@example.test', 'Subject: Plan', 'Message-Id: <m@example.test>'];

describe('journal envelope', () => {
  it('reads To, Cc, Bcc and Recipient lines with Expanded and Forwarded annotations, any case, once per address', () => {
    const result = parseJournalEnvelope([
      ...HEAD,
      'To: bob@example.test',
      'to: DAVE@EXAMPLE.TEST, Expanded: Team@Example.Test',
      'CC: "Carol, C." <carol@example.test>',
      'Bcc: <erin@example.test>, Forwarded: frank@example.test',
      'Recipient: partner@partner.example',
      'To: bob@example.test',
      'To: not an address',
      'X-Unknown: ignored@example.test',
    ].join('\r\n'));
    expect(result).toEqual({
      ok: true,
      envelope: {
        sender: 'alice@example.test',
        onBehalfOf: null,
        messageId: '<m@example.test>',
        addressingKnown: true,
        recipients: [
          { address: 'bob@example.test', field: 'to', expanded: null, forwarded: null },
          { address: 'dave@example.test', field: 'to', expanded: 'team@example.test', forwarded: null },
          { address: 'carol@example.test', field: 'cc', expanded: null, forwarded: null },
          { address: 'erin@example.test', field: 'bcc', expanded: null, forwarded: 'frank@example.test' },
          { address: 'partner@partner.example', field: 'recipient', expanded: null, forwarded: null },
        ],
      },
    });
  });

  it('keeps a comma inside a quoted display name with its address', () => {
    const result = parseJournalEnvelope([...HEAD, 'Cc: "Carol, C." <carol@example.test>, Expanded: "Team, All" <team@example.test>'].join('\n'));
    expect(result.ok && result.envelope.recipients).toEqual([{ address: 'carol@example.test', field: 'cc', expanded: 'team@example.test', forwarded: null }]);
  });

  it('knows internet mail (Recipient lines only) from an authenticated submission', () => {
    const result = parseJournalEnvelope([...HEAD, 'Recipient: bob@example.test'].join('\n'));
    expect(result.ok && result.envelope.addressingKnown).toBe(false);
  });

  it('refuses recipient lines before the Message-Id and a second Message-Id', () => {
    expect(parseJournalEnvelope(['Sender: a@example.test', 'To: x@example.test', 'Message-Id: <m@example.test>', 'To: b@example.test'].join('\n')))
      .toEqual({ ok: false, reason: 'unsafe_envelope' });
    expect(parseJournalEnvelope([...HEAD, 'To: b@example.test', 'Message-Id: <n@example.test>'].join('\n')))
      .toEqual({ ok: false, reason: 'unsafe_envelope' });
  });

  it('refuses an envelope with no recipients or too many', () => {
    expect(parseJournalEnvelope(HEAD.join('\n'))).toEqual({ ok: false, reason: 'no_recipients' });
    const many = Array.from({ length: MAX_JOURNAL_RECIPIENTS + 1 }, (_, index) => `To: u${index}@example.test`);
    expect(parseJournalEnvelope([...HEAD, ...many].join('\n'))).toEqual({ ok: false, reason: 'too_many_recipients' });
  });

  it('accepts only plain addresses', () => {
    expect(envelopeAddress('Bob <Bob@Example.Test>')).toBe('bob@example.test');
    expect(envelopeAddress('"bob@example.test"')).toBe('bob@example.test');
    expect(envelopeAddress('bob@localhost')).toBeNull();
    expect(envelopeAddress('a b@example.test')).toBeNull();
    expect(envelopeAddress(`${'a'.repeat(65)}@example.test`)).toBeNull();
  });

  it('reads the plain-text envelope only (an HTML-only report reads as empty and is refused)', () => {
    expect(envelopeText({ text: 'Sender: a@example.test' })).toBe('Sender: a@example.test');
    expect(envelopeText({})).toBe('');
  });

  it('finds exactly one attached original and names TNEF', () => {
    const rfc822 = { mimeType: 'message/rfc822', content: new TextEncoder().encode('Subject: x\r\n\r\nbody').buffer };
    expect(attachedOriginal([rfc822])).toMatchObject({ ok: true });
    expect(attachedOriginal([rfc822, rfc822])).toEqual({ ok: false, reason: 'ambiguous_original' });
    expect(attachedOriginal([{ mimeType: 'application/ms-tnef', filename: 'winmail.dat', content: new ArrayBuffer(1) }])).toEqual({ ok: false, reason: 'tnef' });
    expect(attachedOriginal([])).toEqual({ ok: false, reason: 'no_original' });
  });
});

describe('journal report trust', () => {
  const config = { tenantId: TENANT, requireAuth: true, authservId: 'mx.example.test', senderDomains: ['example.test'], ndrDomain: 'ndr.example.test' as string | null };
  const headers = (extra: Array<[string, string]>) => [['x-ms-journal-report', ''] as [string, string], ...extra].map(([key, value]) => ({ key, value }));

  it('reads DKIM pass domains only from the trusted, topmost record', () => {
    expect(parseAuthenticationIdentities('mx.example.test; dkim=pass header.d=Example.Test header.s=s1; dkim=fail header.d=bad.example; dkim=pass header.i=@other.example; dmarc=pass', 'mx.example.test'))
      .toEqual({ dmarc: 'pass', dkimPassDomains: ['example.test', 'other.example'], dmarcHeaderFrom: null, spf: null, spfMailFromDomain: null });
    const none = { dmarc: null, dkimPassDomains: [], dmarcHeaderFrom: null, spf: null, spfMailFromDomain: null };
    expect(parseAuthenticationIdentities('mx.attacker.example; dkim=pass header.d=example.test', 'mx.example.test')).toEqual(none);
    expect(parseAuthenticationIdentities('mx.example.test; dkim=pass header.d=example.test', '')).toEqual(none);
    // Only whole domains count: a prefix with junk after it is dropped.
    expect(parseAuthenticationIdentities('mx.example.test; dkim=pass header.d=example.test_.evil.example; dmarc=pass header.from=Example.Test', 'mx.example.test'))
      .toEqual({ dmarc: 'pass', dkimPassDomains: [], dmarcHeaderFrom: 'example.test', spf: null, spfMailFromDomain: null });
    // SPF and the MAIL FROM domain it is about.
    expect(parseAuthenticationIdentities('mx.example.test; spf=pass smtp.mailfrom=journal-ndr@NDR.example.test', 'mx.example.test'))
      .toMatchObject({ spf: 'pass', spfMailFromDomain: 'ndr.example.test' });
    expect(parseAuthenticationIdentities('mx.example.test; spf=pass smtp.mailfrom=x@ndr.example.test_', 'mx.example.test'))
      .toMatchObject({ spf: 'pass', spfMailFromDomain: 'invalid' });
  });

  it('reads quoted property values whole, so they cannot inject a verdict or a domain', () => {
    // A verdict inside a quoted smtp.mailfrom is not a verdict.
    expect(parseAuthenticationResults('mx.example.test; spf=pass smtp.mailfrom="x dmarc=pass"', 'mx.example.test').dmarc).toBeNull();
    expect(parseAuthenticationIdentities('mx.example.test; spf=pass smtp.mailfrom="x dmarc=pass"', 'mx.example.test').dmarc).toBeNull();
    // A header.d inside a quoted reason is not the DKIM domain.
    expect(parseAuthenticationIdentities('mx.example.test; dkim=pass reason="k header.d=tenant"', 'mx.example.test').dkimPassDomains).toEqual([]);
    expect(parseAuthenticationIdentities('mx.example.test; dkim=pass reason="k header.d=example.test"', 'mx.example.test').dkimPassDomains).toEqual([]);
    expect(parseAuthenticationIdentities('mx.example.test; dkim=pass reason="ok; fine" header.d=example.test', 'mx.example.test').dkimPassDomains).toEqual(['example.test']);
    // An unclosed quote ends that resinfo: its leading verdict stays, nothing after the quote is read.
    expect(parseAuthenticationResults('mx.example.test; dkim=pass reason="open header.d=example.test', 'mx.example.test').dkim).toBe('pass');
    expect(parseAuthenticationIdentities('mx.example.test; dkim=pass reason="open header.d=example.test', 'mx.example.test').dkimPassDomains).toEqual([]);
    // An invalid header.from is invalid, not absent, and fails the DMARC path.
    expect(parseAuthenticationIdentities('mx.example.test; dmarc=pass header.from=evil.example_', 'mx.example.test').dmarcHeaderFrom).toBe('invalid');
    const from = { key: 'from', value: 'Microsoft Outlook <MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@example.test>' };
    expect(verifyJournalReport([...headers([]), from, { key: 'authentication-results', value: 'mx.example.test; dkim=none; dmarc=pass header.from=evil.example_' }], config))
      .toEqual({ ok: false, reason: 'auth_failed' });
  });

  it('trims header keys and refuses a header block with a colon-less line', () => {
    expect(headerValues([{ key: 'From ', value: 'a@example.test' }], 'from')).toEqual(['a@example.test']);
    const block = (lines: string[]) => new TextEncoder().encode(`${lines.join('\r\n')}\r\n\r\nbody\r\nX-Junk\r\n`);
    expect(headerBlockWellFormed(block(['From : a@example.test', 'Subject: x', '  folded', 'X-MS-Exchange-CrossTenant-AuthAs: Internal']))).toBe(true);
    expect(headerBlockWellFormed(block(['X-MS-Exchange-CrossTenant-AuthAs: Internal', 'X-Junk', 'X-MS-Exchange-CrossTenant-AuthAs: Anonymous']))).toBe(false);
    expect(headerBlockWellFormed(block([' folded first', 'Subject: x']))).toBe(false);
    expect(headerBlockWellFormed(new TextEncoder().encode('Subject: x\nFrom: a@example.test\n\nbody'))).toBe(true);
  });

  it('takes the From domain only as a whole, plain domain', () => {
    expect(fromDomain('x@tenant.com_.evil.net')).toBeNull();
    expect(fromDomain('x@example.test_.evil.example')).toBeNull();
    expect(fromDomain('Name <x@example.test_.evil.example>')).toBeNull();
    expect(fromDomain('x@example.test.evil.example')).toBe('example.test.evil.example');
    expect(fromDomain('x@example.test (comment)')).toBeNull();
    expect(fromDomain('a@example.test, b@example.test')).toBeNull();
    expect(fromDomain('Evil <a@evil.example> <b@example.test>')).toBeNull();
    expect(fromDomain('a@evil.example <b@example.test>')).toBeNull();
    expect(fromDomain('"Name, With Comma" <x@Example.Test>')).toBe('example.test');
    expect(fromDomain('Microsoft Outlook <MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@example.test>')).toBe('example.test');
  });

  it('reflects live reports: DKIM by the tenant, or SPF for the NDR domain with our tenant id; never DMARC on the From', () => {
    const OTHER = '00000000-0000-0000-0000-00000000beef';
    // Live: the report's From is the ORIGINAL sender (here outside the tenant)
    // and the envelope MAIL FROM is the JournalingReportNdrTo address.
    const from: [string, string] = ['from', 'Pat Partner <pat@partner.example>'];
    const ours: [string, string] = ['x-ms-exchange-crosstenant-id', TENANT];
    const theirs: [string, string] = ['x-ms-exchange-crosstenant-id', OTHER];
    const ar = (value: string): [string, string] => ['authentication-results', `mx.example.test; ${value}`];
    const ndr = 'journal-ndr@ndr.example.test';
    const internal: [string, string] = ['x-ms-exchange-crosstenant-authas', 'Internal'];

    // a. The tenant's own DKIM passes, whatever the From says.
    expect(verifyJournalReport(headers([ar('spf=none; dkim=pass header.d=example.test; dmarc=fail header.from=partner.example'), from]), config, ndr)).toEqual({ ok: true });
    // b. SPF pass for the NDR domain plus AuthAs Internal (tenant ids, when present, include ours).
    expect(verifyJournalReport(headers([ar(`spf=pass smtp.mailfrom=${ndr}; dkim=none; dmarc=none`), from, internal, theirs, ours]), config, ndr)).toEqual({ ok: true });
    expect(verifyJournalReport(headers([ar(`spf=pass smtp.mailfrom=${ndr}; dkim=none`), from, internal]), config, ndr)).toEqual({ ok: true });
    // b without AuthAs Internal (missing, or one instance not Internal), with a foreign tenant id only,
    // with SPF for another domain, or the envelope disagreeing: refused.
    expect(verifyJournalReport(headers([ar(`spf=pass smtp.mailfrom=${ndr}; dkim=none`), from, ours]), config, ndr)).toEqual({ ok: false, reason: 'auth_failed' });
    expect(verifyJournalReport(headers([ar(`spf=pass smtp.mailfrom=${ndr}; dkim=none`), from, internal, ['x-ms-exchange-crosstenant-authas', 'Anonymous']]), config, ndr)).toEqual({ ok: false, reason: 'auth_failed' });
    expect(verifyJournalReport(headers([ar(`spf=pass smtp.mailfrom=${ndr}; dkim=none`), from, internal, theirs]), config, ndr)).toEqual({ ok: false, reason: 'wrong_tenant' });
    expect(verifyJournalReport(headers([ar('spf=pass smtp.mailfrom=bounce@partner.example; dkim=none'), from, internal]), config, 'bounce@partner.example')).toEqual({ ok: false, reason: 'auth_failed' });
    expect(verifyJournalReport(headers([ar(`spf=pass smtp.mailfrom=${ndr}; dkim=none`), from, internal]), config, 'x@evil.example')).toEqual({ ok: false, reason: 'auth_failed' });
    expect(verifyJournalReport(headers([ar('spf=pass smtp.mailfrom=x@ndr.example.test_; dkim=none'), from, internal]), config, null)).toEqual({ ok: false, reason: 'auth_failed' });
    expect(verifyJournalReport(headers([ar(`spf=softfail smtp.mailfrom=${ndr}`), from, internal]), config, ndr)).toEqual({ ok: false, reason: 'auth_failed' });
    expect(verifyJournalReport(headers([ar(`spf=pass smtp.mailfrom=${ndr}`), from, internal]), { ...config, ndrDomain: null }, ndr)).toEqual({ ok: false, reason: 'auth_failed' });
    // DMARC on the From is not used at all, even for a tenant From domain.
    expect(verifyJournalReport(headers([ar('spf=none; dkim=none; dmarc=pass header.from=example.test'), ['from', 'a@example.test'], ours]), config, ndr)).toEqual({ ok: false, reason: 'auth_failed' });
    // DKIM by another domain, or a tenant-domain prefix, is not the tenant's.
    expect(verifyJournalReport(headers([ar('dkim=pass header.d=partner.example'), from]), config, ndr)).toEqual({ ok: false, reason: 'auth_failed' });
    expect(verifyJournalReport(headers([ar('dkim=pass header.d=example.test_.evil.example'), from]), config, ndr)).toEqual({ ok: false, reason: 'auth_failed' });
    // No trusted record at all.
    expect(verifyJournalReport(headers([from, ours]), config, ndr)).toEqual({ ok: false, reason: 'auth_missing' });
    // A forged record below Cloudflare's own is never read.
    expect(verifyJournalReport(headers([ar('spf=fail; dkim=none'), ar('dkim=pass header.d=example.test'), from]), config, ndr)).toEqual({ ok: false, reason: 'auth_failed' });
    // The journal header is mandatory.
    expect(verifyJournalReport([{ key: 'from', value: from[1] }], config, ndr)).toEqual({ ok: false, reason: 'not_journal_report' });
  });

  it('accepts the report when OUR tenant id is among several, refuses when only others are there', () => {
    const OTHER = '00000000-0000-0000-0000-00000000beef';
    const dkim: [string, string] = ['authentication-results', 'mx.example.test; dkim=pass header.d=example.test'];
    expect(verifyJournalReport(headers([dkim, ['x-ms-exchange-crosstenant-id', OTHER], ['x-ms-exchange-crosstenant-id', TENANT]]), config)).toEqual({ ok: true });
    expect(verifyJournalReport(headers([dkim, ['X-MS-Exchange-CrossTenant-Id', ` ${TENANT.toUpperCase()} `]]), config)).toEqual({ ok: true });
    expect(verifyJournalReport(headers([dkim, ['x-ms-exchange-crosstenant-id', OTHER]]), config)).toEqual({ ok: false, reason: 'wrong_tenant' });
    // With authentication on, a report with no tenant header at all is decided by authentication.
    expect(verifyJournalReport(headers([dkim]), config)).toEqual({ ok: true });
  });

  it('without authentication, the tenant id header is optional but, when present, must include ours', () => {
    const open = { ...config, requireAuth: false };
    expect(verifyJournalReport(headers([['x-ms-exchange-crosstenant-id', TENANT]]), open)).toEqual({ ok: true });
    // Live: some reports carry no tenant id at all. Not a reason to refuse.
    expect(verifyJournalReport(headers([]), open)).toEqual({ ok: true });
    expect(verifyJournalReport(headers([['x-ms-exchange-crosstenant-id', TENANT]]), { ...open, tenantId: null })).toEqual({ ok: false, reason: 'wrong_tenant' });
    // The live refusal: a report from another Microsoft 365 organisation's
    // sender carries their tenant id as well as ours. It is ours.
    const other = '00000000-0000-0000-0000-00000000beef';
    expect(verifyJournalReport(headers([['x-ms-exchange-crosstenant-id', other], ['x-ms-exchange-crosstenant-id', TENANT]]), open)).toEqual({ ok: true });
    expect(verifyJournalReport(headers([['x-ms-exchange-crosstenant-id', other]]), open)).toEqual({ ok: false, reason: 'wrong_tenant' });
  });

  it('allows a Sent copy only with AuthAs Internal and this tenant on every instance (fail closed)', () => {
    const envelope = { sender: 'alice@example.test', onBehalfOf: null, messageId: null, recipients: [], addressingKnown: true };
    const internal = [{ key: 'x-ms-exchange-crosstenant-authas', value: 'Internal' }, { key: 'x-ms-exchange-crosstenant-id', value: TENANT }];
    const base = { config: { mirrorSent: true, tenantId: TENANT }, envelope, innerHeaders: internal, innerFrom: 'alice@example.test', innerSender: null, innerHeaderBlockOk: true };
    expect(sentCopyAllowed(base)).toBe(true);
    expect(sentCopyAllowed({ ...base, innerFrom: 'boss@example.test', innerSender: 'alice@example.test' })).toBe(true);
    expect(sentCopyAllowed({ ...base, innerFrom: 'boss@example.test' })).toBe(false);
    expect(sentCopyAllowed({ ...base, envelope: { ...envelope, addressingKnown: false } })).toBe(false);
    expect(sentCopyAllowed({ ...base, innerHeaders: [] })).toBe(false);
    expect(sentCopyAllowed({ ...base, innerHeaders: [internal[0]!] })).toBe(false);
    expect(sentCopyAllowed({ ...base, innerHeaders: [internal[1]!] })).toBe(false);
    expect(sentCopyAllowed({ ...base, innerHeaders: [...internal, { key: 'x-ms-exchange-crosstenant-authas', value: 'Anonymous' }] })).toBe(false);
    expect(sentCopyAllowed({ ...base, innerHeaders: [...internal, { key: 'x-ms-exchange-crosstenant-id', value: '00000000-0000-0000-0000-000000000001' }] })).toBe(false);
    expect(sentCopyAllowed({ ...base, config: { mirrorSent: true, tenantId: null } })).toBe(false);
    expect(sentCopyAllowed({ ...base, config: { mirrorSent: false, tenantId: TENANT } })).toBe(false);
    expect(sentCopyAllowed({ ...base, innerHeaderBlockOk: false })).toBe(false);
  });
});

describe('Exchange mirror configuration', () => {
  it('is off unless the exact journal address is configured', () => {
    expect(isJournalAddress({}, JOURNAL)).toBe(false);
    expect(isJournalAddress({ M365_JOURNAL_ADDRESS: '' }, '')).toBe(false);
    expect(isJournalAddress({ M365_JOURNAL_ADDRESS: ` ${JOURNAL.toUpperCase()} ` }, JOURNAL)).toBe(true);
    expect(isJournalAddress({ M365_JOURNAL_ADDRESS: JOURNAL }, `x${JOURNAL}`)).toBe(false);
  });

  it('needs a random token in the address and names problems without values', () => {
    const base = { MAIL_DOMAIN: 'example.test', INBOUND_AUTHSERV_ID: 'mx.example.test' };
    expect(exchangeMirrorConfig({ ...base, M365_JOURNAL_ADDRESS: 'journal@standby.example.test' })).toMatchObject({ configured: false });
    expect(exchangeMirrorConfig({ ...base, M365_JOURNAL_ADDRESS: 'journal-short@standby.example.test' })).toMatchObject({ configured: false });
    const bad = exchangeMirrorConfig({ M365_JOURNAL_ADDRESS: JOURNAL, M365_TENANT_ID: 'not-a-guid', M365_JOURNAL_REQUIRE_AUTH: 'maybe' });
    expect(bad.configured).toBe(false);
    if (!bad.configured) expect(bad.problems.join(' ')).not.toContain('0123456789abcdef');
    expect(exchangeMirrorConfig({ ...base, M365_JOURNAL_ADDRESS: JOURNAL })).toEqual({
      configured: true,
      config: {
        journalAddress: JOURNAL,
        maskedAddress: 'journal-0123…@standby.example.test',
        senderDomains: ['example.test'],
        requireAuth: true,
        // Sent copies are off until a live test proves the report shape.
        mirrorSent: false,
        tenantId: null,
        ndrDomain: null,
        mailDomain: 'example.test',
        authservId: 'mx.example.test',
      },
    });
    expect(maskJournalAddress('nope')).toBe('');
  });

  it('refuses the weaker modes without a tenant id', () => {
    const base = { MAIL_DOMAIN: 'example.test', INBOUND_AUTHSERV_ID: 'mx.example.test', M365_JOURNAL_ADDRESS: JOURNAL };
    expect(exchangeMirrorConfig({ ...base, M365_JOURNAL_REQUIRE_AUTH: 'false' })).toMatchObject({ configured: false });
    expect(exchangeMirrorConfig({ ...base, M365_JOURNAL_MIRROR_SENT: 'true' })).toMatchObject({ configured: false });
    expect(exchangeMirrorConfig({ ...base, M365_TENANT_ID: TENANT, M365_JOURNAL_REQUIRE_AUTH: 'false', M365_JOURNAL_MIRROR_SENT: 'true' }))
      .toMatchObject({ configured: true, config: { requireAuth: false, mirrorSent: true, tenantId: TENANT } });
  });
});

describe('Exchange mirror config endpoint', () => {
  it('reports settings by name and the address masked, only on the private hostname', async () => {
    const { default: worker } = await import('../index');
    const url = 'https://cmail-email-worker.internal/internal/exchange-mirror/config';
    const env = { M365_JOURNAL_ADDRESS: JOURNAL, MAIL_DOMAIN: 'example.test', INBOUND_AUTHSERV_ID: 'mx.example.test', M365_TENANT_ID: TENANT } as never;
    const body = await (await worker.fetch(new Request(url), env)).text();
    expect(JSON.parse(body)).toEqual({
      configured: true,
      maskedAddress: 'journal-0123…@standby.example.test',
      senderDomains: ['example.test'],
      requireAuth: true,
      mirrorSent: false,
      tenantCheck: true,
    });
    expect(body).not.toContain('0123456789abcdef');
    expect(body).not.toContain(TENANT);
    expect((await worker.fetch(new Request('https://mail.example.test/internal/exchange-mirror/config'), env)).status).toBe(404);
  });
});
