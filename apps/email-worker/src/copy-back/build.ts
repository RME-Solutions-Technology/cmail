// Builds the Microsoft Graph message resource for one cmail message
// (docs/copy-back.md, "What a copy keeps").
//
// Why JSON and not MIME: Graph's create-message call accepts either, but the
// result is a draft (isDraft = true) either way, and a MIME upload cannot also
// carry the extended properties that fix that. With the JSON resource we set
// PidTagMessageFlags (0x0E07) on creation, which is the only point it can be
// set, so the copy is a normal received item, plus PidTagMessageDeliveryTime
// (0x0E06) and PidTagClientSubmitTime (0x0039) so it sorts at its original
// time, our own named marker property so it can be found again, and a
// category the user can see. cmail does not keep the original MIME anyway:
// it stores the sanitised HTML body, the attachments and parsed header fields.
import { participant } from '@cmail/shared/message-participants';
import { COPYBACK_MAX_REQUEST_BYTES, type CopyBackFolder } from '@cmail/shared/copy-back';
import { COPYBACK_MARKER_PROPERTY } from './graph';

/** Shown to the user in Outlook; also a second, human-visible marker. */
export const COPYBACK_CATEGORY = 'cmail standby copy';
/** PidTagMessageFlags = mfRead (0x1): not a draft (mfUnsent clear), no new-mail notification. */
const MESSAGE_FLAGS_READ = '1';
const MAX_RECIPIENTS = 500;

export interface CopyMessageRow {
  id: string;
  folder: CopyBackFolder;
  from_address: string;
  from_name: string;
  to_participants: string;
  cc_participants: string;
  reply_to_participants: string;
  to_addresses: string;
  cc_addresses: string;
  /** Only the sender's own Sent copy ever has Bcc (migration 0015). */
  bcc_participants: string;
  bcc_addresses: string;
  subject: string;
  body_r2_key: string | null;
  is_read: number;
  importance: string;
  message_id_header: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  received_at: string;
  size_bytes: number;
}

export interface CopyAttachmentRow {
  filename: string;
  content_type: string;
  size_bytes: number;
  r2_key: string;
  content_id: string | null;
  disposition: string;
}

export type BuildResult =
  | { ok: true; json: string; bytes: number }
  | { ok: false; reason: 'too_large' | 'body_missing' | 'attachment_missing' | 'bad_message' };

interface Recipient { emailAddress: { address: string; name?: string } }

function recipients(participantsJson: string, addressesJson: string): Recipient[] {
  const parse = (raw: string): unknown[] => {
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  const fromParticipants = parse(participantsJson)
    .map((item) => participant((item as { address?: unknown })?.address, (item as { name?: unknown })?.name));
  const list = fromParticipants.some(Boolean) ? fromParticipants : parse(addressesJson).map((item) => participant(item));
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const entry of list) {
    if (!entry || seen.has(entry.address)) continue;
    seen.add(entry.address);
    out.push({ emailAddress: entry.name ? { address: entry.address, name: entry.name } : { address: entry.address } });
    if (out.length >= MAX_RECIPIENTS) break;
  }
  return out;
}

/** D1 'YYYY-MM-DD HH:MM:SS' (UTC) to ISO 8601. */
export function isoFromDb(value: string): string | null {
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

const HEADER_TOKEN = /^<[^<>\s]{1,994}>$/;
const cleanHeader = (value: string | null, max: number) =>
  (value && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null);

/** The stored Message-ID if it is a single well-formed token, else null. */
export function copyableMessageId(value: string | null): string | null {
  const clean = cleanHeader(value, 998);
  return clean && HEADER_TOKEN.test(clean) ? clean : null;
}

/**
 * Builds the create request. Size is checked twice: an early estimate from
 * stored sizes (no R2 read for a message that cannot fit), then the exact
 * encoded request length.
 */
export async function buildGraphMessage(
  storage: R2Bucket,
  message: CopyMessageRow,
  attachments: CopyAttachmentRow[],
  options: { maxBytes?: number } = {},
): Promise<BuildResult> {
  const maxBytes = options.maxBytes ?? COPYBACK_MAX_REQUEST_BYTES;
  const receivedIso = isoFromDb(message.received_at);
  if (!receivedIso) return { ok: false, reason: 'bad_message' };

  const attachmentBytes = attachments.reduce((total, item) => total + Math.max(0, Number(item.size_bytes) || 0), 0);
  if (Math.ceil(attachmentBytes / 3) * 4 > maxBytes) return { ok: false, reason: 'too_large' };

  // Running estimate of the encoded request, from the real stored sizes, checked
  // before each object is read into memory: nothing over the cap is buffered.
  let estimate = 0;
  let html = '';
  if (message.body_r2_key) {
    const object = await storage.get(message.body_r2_key);
    if (!object) return { ok: false, reason: 'body_missing' };
    estimate += object.size;
    if (estimate > maxBytes) {
      await object.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'too_large' };
    }
    html = await object.text();
  }

  const files: Array<Record<string, unknown>> = [];
  for (const item of attachments) {
    const object = await storage.get(item.r2_key);
    if (!object) return { ok: false, reason: 'attachment_missing' };
    estimate += Math.ceil(object.size / 3) * 4;
    if (estimate > maxBytes) {
      await object.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'too_large' };
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const inline = item.disposition === 'inline' && Boolean(item.content_id);
    files.push({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: item.filename.slice(0, 255) || 'attachment',
      contentType: item.content_type.slice(0, 255) || 'application/octet-stream',
      contentBytes: base64(bytes),
      isInline: inline,
      ...(inline ? { contentId: String(item.content_id).replace(/^<|>$/g, '').slice(0, 255) } : {}),
    });
  }

  const from = participant(message.from_address, message.from_name);
  const sender = from ? { emailAddress: from.name ? { address: from.address, name: from.name } : { address: from.address } } : undefined;
  const internetMessageId = copyableMessageId(message.message_id_header);
  const inReplyTo = cleanHeader(message.in_reply_to, 998);
  const references = cleanHeader(message.references_header, 8 * 998);
  const properties: Array<{ id: string; value: string }> = [
    { id: 'Integer 0x0E07', value: MESSAGE_FLAGS_READ },
    { id: 'SystemTime 0x0E06', value: receivedIso },
    { id: 'SystemTime 0x0039', value: receivedIso },
    { id: COPYBACK_MARKER_PROPERTY, value: message.id },
  ];
  if (inReplyTo && HEADER_TOKEN.test(inReplyTo)) properties.push({ id: 'String 0x1042', value: inReplyTo });
  if (references) properties.push({ id: 'String 0x1039', value: references });

  const importance = message.importance === 'high' || message.importance === 'low' ? message.importance : 'normal';
  const resource: Record<string, unknown> = {
    subject: message.subject.slice(0, 998),
    body: { contentType: 'html', content: html },
    ...(sender ? { from: sender, sender } : {}),
    toRecipients: recipients(message.to_participants, message.to_addresses),
    ccRecipients: recipients(message.cc_participants, message.cc_addresses),
    replyTo: recipients(message.reply_to_participants, '[]'),
    // Bcc only on a Sent copy, as in cmail; received copies never reveal it.
    ...(message.folder === 'sent' ? { bccRecipients: recipients(message.bcc_participants, message.bcc_addresses) } : {}),
    importance,
    isRead: true,
    categories: [COPYBACK_CATEGORY],
    ...(internetMessageId ? { internetMessageId } : {}),
    singleValueExtendedProperties: properties,
    ...(files.length ? { attachments: files } : {}),
  };
  const json = JSON.stringify(resource);
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > maxBytes) return { ok: false, reason: 'too_large' };
  return { ok: true, json, bytes };
}
