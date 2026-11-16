import { describe, expect, it } from 'vitest';
import { MAX_DIAGNOSTIC, countOriginalHeaders, journalDiagnostic } from './diagnostic';

const TENANT = '00000000-0000-0000-0000-000000000000';
const h = (key: string, value: string) => ({ key, value });

describe('journal report diagnostic', () => {
  it('keeps only allowlisted headers, and only values with the expected shape', () => {
    const text = journalDiagnostic([
      h('X-MS-Journal-Report', ''),
      h('X-MS-Exchange-CrossTenant-Id', TENANT),
      h('X-MS-Exchange-CrossTenant-Id', 'not a guid, please'),
      h('X-MS-Exchange-CrossTenant-OriginalArrivalTime', '16 Nov 2026 01:02:03.0000 (UTC)'),
      h('X-MS-Exchange-CrossTenant-AuthAs', 'Internal'),
      h('X-MS-Exchange-CrossTenant-AuthSource', 'Pat Partner <pat@partner.example>'),
      h('X-MS-Exchange-Organization-SCL', '-1'),
      // Not on the allowlist, even with the right prefix.
      h('X-MS-Exchange-CrossTenant-UserPrincipalName', 'pat@partner.example'),
      h('X-MS-Exchange-Organization-Recipient-P2-Type', 'Bcc'),
      h('Subject', 'Quarterly plan'),
      h('From', 'Pat Partner <pat@partner.example>'),
    ], null);
    expect(text).toContain('x-ms-journal-report: ');
    expect(text).toContain(`x-ms-exchange-crosstenant-id: ${TENANT}`);
    expect(text).toContain('x-ms-exchange-crosstenant-id: <hidden, 18 chars>');
    expect(text).toContain('x-ms-exchange-crosstenant-originalarrivaltime: 16 Nov 2026 01:02:03.0000 (UTC)');
    expect(text).toContain('x-ms-exchange-crosstenant-authas: Internal');
    expect(text).toContain('x-ms-exchange-crosstenant-authsource: <hidden, 33 chars>');
    expect(text).toContain('x-ms-exchange-organization-scl: -1');
    for (const forbidden of ['userprincipalname', 'recipient-p2-type', 'Quarterly', 'Pat', 'pat@', 'partner.example', 'please']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('summarises Authentication-Results as verdicts and domains only (no local part, display name, reason or comment)', () => {
    const text = journalDiagnostic([
      h('Authentication-Results', 'mx.cloudflare.net; spf=pass (mx.cloudflare.net: domain of "john doe"@ndr.example.test designates 192.0.2.1) smtp.mailfrom="john doe"@ndr.example.test; '
        + 'dkim=pass header.d=example.test header.s=selector1 header.b=AbCd; dmarc=fail reason="Pat Partner <pat@partner.example> said hi" header.from=partner.example; '
        + 'arc=none smtp.remote-ip=192.0.2.1'),
      h('DKIM-Signature', 'v=1; a=rsa-sha256; d=Example.Test; s=selector1; h=From:Subject; bh=abc=; b=def='),
      h('DKIM-Signature', 'v=1; d=evil example; s=<script>'),
    ], null);
    expect(text).toContain('authentication-results: authserv=mx.cloudflare.net; spf=pass smtp.mailfrom=ndr.example.test; dkim=pass header.d=example.test; dmarc=fail header.from=partner.example; arc=none');
    expect(text).toContain('dkim-signature: d=example.test s=selector1');
    expect(text).toContain('dkim-signature: d=<hidden> s=<hidden>');
    for (const forbidden of ['john', 'doe', 'Pat', 'pat@', 'said hi', 'designates', '192.0.2.1', 'AbCd', 'bh=', 'def=', '<script>']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('caps the number of headers and the total length', () => {
    const many = Array.from({ length: 50 }, () => h('X-MS-Exchange-CrossTenant-Id', TENANT));
    const text = journalDiagnostic(many, null);
    expect(text.match(/x-ms-exchange-crosstenant-id:/g)).toHaveLength(30);
    expect(text).toContain('| …');
    const long = Array.from({ length: 30 }, () => h('Authentication-Results', `mx.cloudflare.net; ${Array.from({ length: 20 }, (_, i) => `dkim=pass header.d=d${i}.example.test`).join('; ')}`));
    expect(journalDiagnostic(long, null).length).toBeLessThanOrEqual(MAX_DIAGNOSTIC);
  });

  it('counts allowlisted headers in the original header block only', () => {
    const raw = new TextEncoder().encode([
      'From: Pat <pat@partner.example>',
      `X-MS-Exchange-CrossTenant-Id: ${TENANT}`,
      'X-MS-Exchange-CrossTenant-AuthAs: Anonymous',
      '  folded continuation',
      'X-MS-Exchange-Organization-SCL: 1',
      'X-MS-Exchange-CrossTenant-UserPrincipalName: x',
      'DKIM-Signature: v=1; d=partner.example',
      '',
      'X-MS-Exchange-CrossTenant-Id: in the body, not counted',
    ].join('\r\n'));
    expect(countOriginalHeaders(raw)).toBe(4);
    expect(countOriginalHeaders(new TextEncoder().encode('Subject: x\n\nX-MS-Journal-Report: body'))).toBe(0);
    expect(countOriginalHeaders(null)).toBe(0);
    expect(journalDiagnostic([], raw)).toBe('outer headers: none of interest; original: 4 such headers');
  });
});
