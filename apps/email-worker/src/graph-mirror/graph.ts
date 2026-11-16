// Microsoft Graph calls for the Exchange mirror's Graph source
// (docs/exchange-mirror.md#graph-source-recommended). It extends the
// Microsoft 365 sync client, so it keeps the same rules: an app-only token
// sent only to https://graph.microsoft.com/v1.0/ URLs (including next and
// delta links from a response), capped bodies, a request timeout,
// Retry-After on 429/503/504, and errors that carry a short code and the
// HTTP status only (never bodies, tokens or addresses).
//
// Two reads, both on one mailbox, both needing Mail.Read:
// - GET users/{id}/mailFolders/{well-known}/messages/delta  (what is new)
// - GET users/{id}/messages/{id}/$value                    (the MIME)
// It never writes, moves, deletes or sends anything in Microsoft 365.
import type { GraphMirrorFolder } from '@cmail/shared/graph-mirror';
import { GRAPH_ROOT, GraphClient, GraphError, isGraphUrl } from '../m365-sync/graph';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Messages per delta page (Prefer: odata.maxpagesize). */
export const DELTA_PAGE_SIZE = 50;
/** Only these are asked for: enough to decide, without reading content. */
const DELTA_SELECT = 'internetMessageId,receivedDateTime,isDraft';

export interface DeltaMessage {
  /** Graph message id (opaque, used only to fetch the MIME). */
  id: string;
  internetMessageId: string | null;
  /** receivedDateTime in epoch ms, or null when absent or unreadable. */
  receivedMs: number | null;
  isDraft: boolean;
  /** `@removed`: deleted or moved out of the folder. Never acted on. */
  removed: boolean;
}

export interface MessageDeltaPage {
  messages: DeltaMessage[];
  nextLink: string | null;
  deltaLink: string | null;
}

/**
 * The first request of a round for one folder: only messages received at or
 * after `sinceMs` (the one $filter message delta supports), newest first (the
 * one $orderby it supports), so a capped first pull keeps the newest mail.
 * https://learn.microsoft.com/en-us/graph/api/message-delta
 */
export function initialDeltaUrl(objectId: string, folder: GraphMirrorFolder, sinceMs: number): string {
  if (!GUID.test(objectId)) throw new GraphError('bad_response', 0);
  const since = new Date(Math.max(0, Math.floor(sinceMs / 1000) * 1000)).toISOString().replace('.000Z', 'Z');
  return `${GRAPH_ROOT}users/${objectId}/mailFolders/${folder}/messages/delta?$select=${DELTA_SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}&$orderby=${encodeURIComponent('receivedDateTime desc')}`;
}

function parseMessage(value: unknown): DeltaMessage | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id || record.id.length > 512) return null;
  const mid = typeof record.internetMessageId === 'string' && record.internetMessageId.length <= 998 ? record.internetMessageId : null;
  const received = typeof record.receivedDateTime === 'string' ? Date.parse(record.receivedDateTime) : Number.NaN;
  return {
    id: record.id,
    internetMessageId: mid,
    receivedMs: Number.isFinite(received) ? received : null,
    isDraft: record.isDraft === true,
    removed: record['@removed'] !== undefined,
  };
}

export class GraphMirrorClient extends GraphClient {
  /** Gets the app token up front, so a credential problem stops the run before any mailbox is read. */
  async ensureToken(): Promise<void> {
    await this.accessToken();
  }

  /** One page of a folder's message delta. `url` is initialDeltaUrl(), a nextLink or a deltaLink. */
  async messageDeltaPage(url: string): Promise<MessageDeltaPage> {
    const body = await this.graphJson(url, { method: 'GET', headers: { Prefer: `odata.maxpagesize=${DELTA_PAGE_SIZE}` } }) as Record<string, unknown> | null;
    if (!body || !Array.isArray(body.value)) throw new GraphError('bad_response', 200);
    const next = body['@odata.nextLink'] ?? null;
    const delta = body['@odata.deltaLink'] ?? null;
    if ((next !== null && !isGraphUrl(next)) || (delta !== null && !isGraphUrl(delta))) throw new GraphError('bad_response', 200);
    if ((next === null) === (delta === null)) throw new GraphError('bad_response', 200);
    const messages = (body.value as unknown[]).map(parseMessage).filter((item): item is DeltaMessage => item !== null);
    return { messages, nextLink: next as string | null, deltaLink: delta as string | null };
  }

  /** The message as MIME, or null when it is larger than `maxBytes`. */
  async messageMime(objectId: string, messageId: string, maxBytes: number): Promise<Uint8Array | null> {
    if (!GUID.test(objectId) || !messageId || messageId.length > 512) throw new GraphError('bad_response', 0);
    return this.graphBytes(`${GRAPH_ROOT}users/${objectId}/messages/${encodeURIComponent(messageId)}/$value`, maxBytes);
  }
}
