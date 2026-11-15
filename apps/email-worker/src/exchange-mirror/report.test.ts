import { describe, expect, it } from 'vitest';
import { parseAuthenticationIdentities } from '../authentication-results';
import { exchangeMirrorConfig, isJournalAddress, maskJournalAddress } from '@cmail/shared/exchange-mirror';
import { attachedOriginal, envelopeAddress, envelopeText, MAX_JOURNAL_RECIPIENTS, parseJournalEnvelope } from './report';
import { fromDomain, verifyJournalReport } from './verify';
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

  it('falls back to the HTML body as text', () => {
    expect(envelopeText({ html: '<p>Sender: a@example.test<br>To: b@example.test &lt;x&gt;</p>' })).toBe('Sender: a@example.test\nTo: b@example.test <x>\n');
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
  const config = { tenantId: TENANT, requireAuth: true, authservId: 'mx.example.test', senderDomains: ['example.test'] };
  const headers = (extra: Array<[string, string]>) => [['x-ms-journal-report', ''] as [string, string], ...extra].map(([key, value]) => ({ key, value }));

  it('reads DKIM pass domains only from the trusted, topmost record', () => {
    expect(parseAuthenticationIdentities('mx.example.test; dkim=pass header.d=Example.Test header.s=s1; dkim=fail header.d=bad.example; dkim=pass header.i=@other.example; dmarc=pass', 'mx.example.test'))
      .toEqual({ dmarc: 'pass', dkimPassDomains: ['example.test', 'other.example'] });
    expect(parseAuthenticationIdentities('mx.attacker.example; dkim=pass header.d=example.test', 'mx.example.test'))
      .toEqual({ dmarc: null, dkimPassDomains: [] });
    expect(parseAuthenticationIdentities('mx.example.test; dkim=pass header.d=example.test', ''))
      .toEqual({ dmarc: null, dkimPassDomains: [] });
  });

  it('needs the journal header, the right tenant and an authenticated tenant domain', () => {
    const auth: [string, string] = ['authentication-results', 'mx.example.test; spf=pass; dkim=none; dmarc=pass'];
    const from: [string, string] = ['from', 'Microsoft Outlook <MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@example.test>'];
    expect(verifyJournalReport(headers([auth, from]), config)).toEqual({ ok: true });
    expect(verifyJournalReport([{ key: 'from', value: from[1] }], config)).toEqual({ ok: false, reason: 'not_journal_report' });
    expect(verifyJournalReport(headers([auth, from, ['x-ms-exchange-crosstenant-id', TENANT], ['x-ms-exchange-crosstenant-id', '00000000-0000-0000-0000-000000000001']]), config))
      .toEqual({ ok: false, reason: 'wrong_tenant' });
    // A forged record below Cloudflare's own is never read.
    expect(verifyJournalReport(headers([['authentication-results', 'mx.example.test; dmarc=fail'], ['authentication-results', 'mx.example.test; dmarc=pass'], from]), config))
      .toEqual({ ok: false, reason: 'auth_failed' });
    // Two From addresses: DMARC cannot vouch for either.
    expect(verifyJournalReport(headers([auth, ['from', 'a@example.test, b@example.test']]), config)).toEqual({ ok: false, reason: 'auth_failed' });
    expect(fromDomain('"Name, With Comma" <x@Example.Test>')).toBe('example.test');
  });

  it('allows a Sent copy only for an authenticated internal submission by the From', () => {
    const envelope = { sender: 'alice@example.test', onBehalfOf: null, messageId: null, recipients: [], addressingKnown: true };
    const base = { config: { mirrorSent: true, tenantId: TENANT }, envelope, innerHeaders: [] as Array<{ key: string; value: string }>, innerFrom: 'alice@example.test', innerSender: null };
    expect(sentCopyAllowed(base)).toBe(true);
    expect(sentCopyAllowed({ ...base, innerFrom: 'boss@example.test', innerSender: 'alice@example.test' })).toBe(true);
    expect(sentCopyAllowed({ ...base, innerFrom: 'boss@example.test' })).toBe(false);
    expect(sentCopyAllowed({ ...base, envelope: { ...envelope, addressingKnown: false } })).toBe(false);
    expect(sentCopyAllowed({ ...base, innerHeaders: [{ key: 'x-ms-exchange-crosstenant-authas', value: 'Anonymous' }] })).toBe(false);
    expect(sentCopyAllowed({ ...base, config: { mirrorSent: false, tenantId: TENANT } })).toBe(false);
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
        mirrorSent: true,
        tenantId: null,
        mailDomain: 'example.test',
        authservId: 'mx.example.test',
      },
    });
    expect(maskJournalAddress('nope')).toBe('');
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
      mirrorSent: true,
      tenantCheck: true,
    });
    expect(body).not.toContain('0123456789abcdef');
    expect(body).not.toContain(TENANT);
    expect((await worker.fetch(new Request('https://mail.example.test/internal/exchange-mirror/config'), env)).status).toBe(404);
  });
});
