// Test-only: Exchange Online journal reports built from Microsoft's
// documented envelope journaling format (docs/exchange-mirror.md). Never
// imported by the Worker. example.test addresses and placeholder GUIDs only.

export const DOMAIN = 'example.test';
export const TENANT = '00000000-0000-0000-0000-000000000000';
export const OTHER_TENANT = '00000000-0000-0000-0000-00000000beef';
export const JOURNAL = 'journal-0123456789abcdef0123456789abcdef@standby.example.test';
export const AUTHSERV = 'mx.example.test';

export interface InnerOptions {
  from?: string;
  sender?: string;
  to?: string;
  cc?: string;
  subject?: string;
  messageId?: string | null;
  body?: string;
  headers?: Record<string, string>;
  /**
   * Default true: the tenant headers Exchange Online puts on mail a user of
   * this tenant submitted (AuthAs Internal, this tenant id). false: none.
   */
  internal?: boolean;
  /** Header lines written exactly as given (for malformed-header tests). */
  rawHeaderLines?: string[];
  attachment?: { filename: string; type: string; base64: string };
}

/** The original message, as a mail client would have sent it. */
export function innerMessage(options: InnerOptions = {}): string {
  const lines = [
    `From: ${options.from ?? 'Alice Example <alice@example.test>'}`,
    ...(options.sender ? [`Sender: ${options.sender}`] : []),
    `To: ${options.to ?? 'Bob Example <bob@example.test>'}`,
    ...(options.cc ? [`Cc: ${options.cc}`] : []),
    `Subject: ${options.subject ?? 'Quarterly plan'}`,
    ...(options.messageId === null ? [] : [`Message-ID: ${options.messageId ?? '<plan-1@example.test>'}`]),
    'Date: Mon, 16 Nov 2026 09:00:00 +1100',
    ...(options.internal === false ? [] : ['X-MS-Exchange-CrossTenant-AuthAs: Internal', `X-MS-Exchange-CrossTenant-Id: ${TENANT}`]),
    ...Object.entries(options.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
    ...(options.rawHeaderLines ?? []),
    'MIME-Version: 1.0',
  ];
  if (!options.attachment) {
    return [...lines, 'Content-Type: text/plain; charset=utf-8', '', options.body ?? 'Hello team, the plan is attached in spirit.', ''].join('\r\n');
  }
  return [
    ...lines,
    'Content-Type: multipart/mixed; boundary="INNER"',
    '',
    '--INNER',
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.body ?? 'See attached.',
    '--INNER',
    `Content-Type: ${options.attachment.type}; name="${options.attachment.filename}"`,
    `Content-Disposition: attachment; filename="${options.attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    options.attachment.base64,
    '--INNER--',
    '',
  ].join('\r\n');
}

export interface ReportOptions {
  /** Envelope body lines (Sender, Subject, Message-Id, then recipients). */
  envelope?: string[];
  inner?: string;
  /** null omits the header. */
  authenticationResults?: string | null;
  from?: string;
  journalHeader?: boolean;
  tenantHeader?: string | null;
  extraHeaders?: Record<string, string>;
  /** Attach the original as TNEF instead of message/rfc822. */
  tnef?: boolean;
  /** Attach the original twice. */
  twoOriginals?: boolean;
}

export function defaultEnvelope(): string[] {
  return [
    'Sender: alice@example.test',
    'Subject: Quarterly plan',
    'Message-Id: <plan-1@example.test>',
    'To: bob@example.test',
  ];
}

/** A journal report as Exchange Online delivers it to an external journal address. */
export function journalReport(options: ReportOptions = {}): string {
  const inner = options.inner ?? innerMessage();
  const headers = [
    ...(options.authenticationResults === null ? [] : [`Authentication-Results: ${options.authenticationResults
      ?? `${AUTHSERV}; spf=pass smtp.mailfrom=${DOMAIN}; dkim=pass header.d=${DOMAIN} header.s=selector1; dmarc=pass header.from=${DOMAIN}`}`]),
    `From: ${options.from ?? `Microsoft Outlook <MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@${DOMAIN}>`}`,
    `To: ${JOURNAL}`,
    'Subject: Quarterly plan',
    `Message-ID: <journal-report-${Math.random().toString(36).slice(2)}@${DOMAIN}>`,
    'Date: Mon, 16 Nov 2026 09:00:01 +1100',
    ...(options.journalHeader === false ? [] : ['X-MS-Journal-Report: ']),
    ...(options.tenantHeader === null ? [] : [`X-MS-Exchange-CrossTenant-Id: ${options.tenantHeader ?? TENANT}`]),
    ...Object.entries(options.extraHeaders ?? {}).map(([key, value]) => `${key}: ${value}`),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="JOURNAL"',
  ];
  const original = options.tnef
    ? ['Content-Type: application/ms-tnef; name="winmail.dat"', 'Content-Disposition: attachment; filename="winmail.dat"', 'Content-Transfer-Encoding: base64', '', 'eJ8+IhAAAQaQCAAEAAAAAAABAAEAAQeQBgAIAAAA5AQAAAAAAADoAAEIgAcAGAAAAElQTS5NaWNyb3NvZnQgTWFpbC5Ob3RlADEIAQ2ABAACAAAAAgACAAEFgAMADgAAAA==']
    : ['Content-Type: message/rfc822', 'Content-Disposition: attachment', '', inner];
  const parts = [
    '--JOURNAL',
    'Content-Type: text/plain; charset=utf-8',
    '',
    ...(options.envelope ?? defaultEnvelope()),
    '',
    '--JOURNAL',
    ...original,
    ...(options.twoOriginals ? ['--JOURNAL', 'Content-Type: message/rfc822', 'Content-Disposition: attachment', '', inner] : []),
    '--JOURNAL--',
    '',
  ];
  return [...headers, '', ...parts].join('\r\n');
}
