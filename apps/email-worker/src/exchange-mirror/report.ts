// Reading an Exchange Online journal report (docs/exchange-mirror.md).
//
// Exchange Online uses envelope journaling only: the report's body lists the
// original message's envelope (sender, subject, Message-ID and one line per
// recipient) and the original is attached unaltered. Field names and the
// recipient annotations ("Expanded:" for the distribution group a recipient
// came from, "Forwarded:" for the mailbox that forwarded to them) follow
// Microsoft's documented journal report format:
// https://learn.microsoft.com/en-us/exchange/security-and-compliance/journaling/journaling
// https://learn.microsoft.com/en-us/previous-versions/office/exchange-server-2007/bb331962(v=exchg.80)
//
// Pure functions only: no I/O, nothing here decides where mail is filed.

export type RecipientField = 'to' | 'cc' | 'bcc' | 'recipient';

export interface JournalRecipient {
  /** Lower-case addr-spec of the mailbox the copy was delivered to. */
  address: string;
  field: RecipientField;
  /** The distribution group this recipient was expanded from, if any. */
  expanded: string | null;
  /** The mailbox that forwarded to this recipient, if any. */
  forwarded: string | null;
}

export interface JournalEnvelope {
  sender: string | null;
  onBehalfOf: string | null;
  messageId: string | null;
  /** Unique by address, in the order first seen. */
  recipients: JournalRecipient[];
  /** True when any To/Cc/Bcc line was present (addressing known: authenticated submission). */
  addressingKnown: boolean;
}

export type EnvelopeResult =
  | { ok: true; envelope: JournalEnvelope }
  | { ok: false; reason: 'no_recipients' | 'too_many_recipients' | 'unsafe_envelope' };

/** One report never files to more distinct recipients than this. */
export const MAX_JOURNAL_RECIPIENTS = 5_000;
/** Envelope text beyond this is not read (a 5,000-recipient envelope is far smaller). */
export const MAX_ENVELOPE_CHARS = 2 * 1024 * 1024;

const ADDRESS = /^[^\s@<>",;:()[\]\\]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lower-cased addr-spec from `addr`, `<addr>` or `Name <addr>`, else null. */
export function envelopeAddress(value: string): string | null {
  let candidate = value.trim();
  const angle = /<([^<>]*)>\s*$/.exec(candidate);
  if (angle) candidate = angle[1] ?? '';
  candidate = candidate.trim().replace(/^"(.*)"$/, '$1').toLowerCase();
  if (candidate.length > 320) return null;
  return ADDRESS.test(candidate) ? candidate : null;
}

/** Split on commas that are not inside a quoted display name. */
function splitOutsideQuotes(value: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

const RECIPIENT_FIELDS: Record<string, RecipientField> = { to: 'to', cc: 'cc', bcc: 'bcc', recipient: 'recipient' };

/**
 * Parses the envelope text of a journal report.
 *
 * The Subject line carries the original, sender-chosen subject. If Exchange
 * ever wrote a decoded line break from it into the envelope, the sender
 * could add lines of their own. So recipient lines are read only after the
 * Message-Id line, and the whole envelope is refused ('unsafe_envelope')
 * when a recipient line comes before the Message-Id or there is more than
 * one Message-Id line: either can only come from injected text.
 */
export function parseJournalEnvelope(text: string): EnvelopeResult {
  const lines = text.slice(0, MAX_ENVELOPE_CHARS).split(/\r\n|\r|\n/);
  let sender: string | null = null;
  let onBehalfOf: string | null = null;
  let messageId: string | null = null;
  let seenMessageId = false;
  let addressingKnown = false;
  const byAddress = new Map<string, JournalRecipient>();

  for (const rawLine of lines) {
    const match = /^\s*([A-Za-z][A-Za-z-]{0,30})\s*:\s*(.*)$/.exec(rawLine);
    if (!match) continue;
    const key = (match[1] || '').toLowerCase();
    const value = (match[2] || '').trim();
    if (key === 'message-id' && seenMessageId) return { ok: false, reason: 'unsafe_envelope' };
    if (!seenMessageId) {
      if (RECIPIENT_FIELDS[key]) return { ok: false, reason: 'unsafe_envelope' };
      if (key === 'sender' && sender === null) sender = envelopeAddress(value);
      else if (key === 'on-behalf-of' && onBehalfOf === null) onBehalfOf = envelopeAddress(value);
      else if (key === 'message-id') {
        seenMessageId = true;
        const id = /<[^<>\s@]{1,900}@[^<>\s@]{1,255}>/.exec(value)?.[0];
        messageId = id ?? null;
      }
      continue;
    }
    if (key === 'on-behalf-of' && onBehalfOf === null) {
      onBehalfOf = envelopeAddress(value);
      continue;
    }
    const field = RECIPIENT_FIELDS[key];
    if (!field) continue;
    const parts = splitOutsideQuotes(value);
    const address = envelopeAddress(parts[0] ?? '');
    if (!address) continue;
    let expanded: string | null = null;
    let forwarded: string | null = null;
    for (const part of parts.slice(1)) {
      const annotation = /^\s*(expanded|forwarded)\s*:\s*(.+)$/i.exec(part);
      if (!annotation) continue;
      const target = envelopeAddress(annotation[2] ?? '');
      if ((annotation[1] || '').toLowerCase() === 'expanded') expanded ??= target;
      else forwarded ??= target;
    }
    if (field !== 'recipient') addressingKnown = true;
    if (!byAddress.has(address)) {
      if (byAddress.size >= MAX_JOURNAL_RECIPIENTS) return { ok: false, reason: 'too_many_recipients' };
      byAddress.set(address, { address, field, expanded, forwarded });
    }
  }
  if (!byAddress.size) return { ok: false, reason: 'no_recipients' };
  return {
    ok: true,
    envelope: { sender, onBehalfOf, messageId, recipients: [...byAddress.values()], addressingKnown },
  };
}

interface ParsedAttachmentLike {
  mimeType?: string;
  filename?: string | null;
  content: ArrayBuffer | Uint8Array | string;
}

export type OriginalResult =
  | { ok: true; raw: Uint8Array }
  | { ok: false; reason: 'no_original' | 'ambiguous_original' | 'tnef' };

/** The one attached original (message/rfc822) of a parsed journal report. */
export function attachedOriginal(attachments: readonly ParsedAttachmentLike[] | undefined): OriginalResult {
  const list = attachments ?? [];
  const originals = list.filter((attachment) => (attachment.mimeType || '').toLowerCase() === 'message/rfc822');
  if (originals.length > 1) return { ok: false, reason: 'ambiguous_original' };
  const original = originals[0];
  if (!original) {
    const tnef = list.some((attachment) => (attachment.mimeType || '').toLowerCase() === 'application/ms-tnef'
      || (attachment.filename || '').toLowerCase() === 'winmail.dat');
    return { ok: false, reason: tnef ? 'tnef' : 'no_original' };
  }
  const content = original.content;
  const raw = typeof content === 'string'
    ? new TextEncoder().encode(content)
    : content instanceof Uint8Array ? content : new Uint8Array(content);
  return { ok: true, raw };
}

/** The report's envelope text: the plain-text body, or the HTML body as text. */
export function envelopeText(parsed: { text?: string; html?: string }): string {
  if (parsed.text && parsed.text.trim()) return parsed.text;
  const html = (parsed.html || '').slice(0, MAX_ENVELOPE_CHARS);
  return html
    .replace(/<(?:br|\/p|\/div|\/tr|\/li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
