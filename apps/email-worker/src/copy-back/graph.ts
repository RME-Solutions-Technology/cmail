// Microsoft Graph calls for copying standby mail back into Exchange Online
// (docs/copy-back.md). It extends the Microsoft 365 sync client, so it keeps
// the same rules: an app-only token sent only to
// https://graph.microsoft.com/v1.0/ URLs, capped response bodies, a request
// timeout, Retry-After on 429/503/504, and errors that carry a short code
// and HTTP status only (never bodies, tokens or addresses).
//
// It makes four kinds of call, all on one user's mailbox:
// - GET  users/{id}/messages?$filter=<our marker>        (duplicate check)
// - GET  users/{id}/messages?$filter=internetMessageId    (already delivered)
// - POST users/{id}/mailFolders/{well-known}/messages     (create the copy)
// - PATCH users/{id}/messages/{id} { isRead: false }      (restore unread)
// It never deletes, moves or sends mail, and never uses upload sessions or
// the import API (those use pre-authenticated outlook.office.com URLs).
import { COPYBACK_MESSAGE_ID } from '@cmail/shared/copy-back';
import { GRAPH_ROOT, GraphClient, GraphError } from '../m365-sync/graph';

/**
 * Our named MAPI property set (a fixed, public GUID that identifies cmail, not
 * a tenant). The marker value is the cmail message id, so a copy can always
 * be found again, even after the user moves it to another folder.
 */
export const COPYBACK_PROPERTY_SET = '{8d0b7a4e-3c1f-4b6e-9a52-6f1e2d4c7b90}';
export const COPYBACK_MARKER_PROPERTY = `String ${COPYBACK_PROPERTY_SET} Name cmailStandbyCopyId`;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WELL_KNOWN = new Set(['inbox', 'archive', 'sentitems']);
/** Enough to see past a handful of our own copies sharing a Message-ID (Inbox and Sent of a self-addressed message). */
const MID_LOOKUP_TOP = 10;

export interface ExchangeItem {
  id: string;
  /** True when Exchange holds the item as a draft: the copy did not become a received item. */
  isDraft: boolean;
}

function userPath(objectId: string): string {
  if (!GUID.test(objectId)) throw new GraphError('bad_response', 0);
  return `${GRAPH_ROOT}users/${objectId}`;
}

/** OData string literal: single quotes doubled. */
function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function item(value: unknown, status: number): ExchangeItem {
  const id = (value as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !id || id.length > 512) throw new GraphError('bad_response', status);
  return { id, isDraft: (value as { isDraft?: unknown }).isDraft === true };
}

function list(body: unknown): unknown[] {
  const value = (body as { value?: unknown } | null)?.value;
  if (!Array.isArray(value)) throw new GraphError('bad_response', 200);
  return value;
}

export class CopyBackGraphClient extends GraphClient {
  /** Gets the app token up front, so a token problem stops the run before any mailbox is touched. */
  async ensureToken(): Promise<void> {
    await this.accessToken();
  }

  /** Our earlier copy of this cmail message in the mailbox, or null. */
  async findCopy(objectId: string, marker: string): Promise<ExchangeItem | null> {
    if (!COPYBACK_MESSAGE_ID.test(marker)) throw new GraphError('bad_response', 0);
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq ${odataString(COPYBACK_MARKER_PROPERTY)} and ep/value eq ${odataString(marker)})`;
    const body = await this.graphJson(`${userPath(objectId)}/messages?$filter=${encodeURIComponent(filter)}&$select=id,isDraft&$top=1`, { method: 'GET' });
    const first = list(body)[0];
    return first === undefined ? null : item(first, 200);
  }

  /**
   * True when the mailbox holds a message with this Message-ID that is NOT one
   * of our copies (our copies carry the marker property, expanded here), so a
   * self-addressed message copied to Sent does not hide its Inbox copy.
   */
  async hasNativeMessage(objectId: string, internetMessageId: string): Promise<boolean> {
    if (!internetMessageId || internetMessageId.length > 998 || /[\u0000-\u001f\u007f]/.test(internetMessageId)) return false;
    const filter = `internetMessageId eq ${odataString(internetMessageId)}`;
    const expand = `singleValueExtendedProperties($filter=id eq ${odataString(COPYBACK_MARKER_PROPERTY)})`;
    const body = await this.graphJson(
      `${userPath(objectId)}/messages?$filter=${encodeURIComponent(filter)}&$select=id&$expand=${encodeURIComponent(expand)}&$top=${MID_LOOKUP_TOP}`,
      { method: 'GET' },
    );
    return list(body).some((entry) => {
      const props = (entry as { singleValueExtendedProperties?: unknown }).singleValueExtendedProperties;
      return !(Array.isArray(props) && props.length > 0);
    });
  }

  /** Creates the copy in a well-known folder. */
  async createMessage(objectId: string, folder: string, message: string): Promise<ExchangeItem> {
    if (!WELL_KNOWN.has(folder)) throw new GraphError('bad_response', 0);
    const body = await this.graphJson(`${userPath(objectId)}/mailFolders/${folder}/messages`, { method: 'POST', body: message });
    return item(body, 201);
  }

  async markUnread(objectId: string, messageId: string): Promise<void> {
    if (!messageId || messageId.length > 512) throw new GraphError('bad_response', 0);
    await this.graphJson(`${userPath(objectId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ isRead: false }),
    });
  }
}
