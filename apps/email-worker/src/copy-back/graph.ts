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
import { GRAPH_ROOT, GraphClient, GraphError } from '../m365-sync/graph';

/**
 * Our named MAPI property set (a fixed, public GUID that identifies cmail, not
 * a tenant). The marker value is the cmail message id, so a copy can always
 * be found again, even after the user moves it to another folder.
 */
export const COPYBACK_PROPERTY_SET = '{8d0b7a4e-3c1f-4b6e-9a52-6f1e2d4c7b90}';
export const COPYBACK_MARKER_PROPERTY = `String ${COPYBACK_PROPERTY_SET} Name cmailStandbyCopyId`;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** cmail message ids are UUIDs or similar opaque tokens. Nothing that needs OData escaping. */
const MARKER = /^[A-Za-z0-9._:-]{1,64}$/;
const WELL_KNOWN = new Set(['inbox', 'archive', 'sentitems']);

function userPath(objectId: string): string {
  if (!GUID.test(objectId)) throw new GraphError('bad_response', 0);
  return `${GRAPH_ROOT}users/${objectId}`;
}

/** OData string literal: single quotes doubled. */
function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function firstId(body: unknown): string | null {
  const value = (body as { value?: unknown } | null)?.value;
  if (!Array.isArray(value)) throw new GraphError('bad_response', 200);
  const id = (value[0] as { id?: unknown } | undefined)?.id;
  if (id === undefined) return null;
  if (typeof id !== 'string' || !id || id.length > 512) throw new GraphError('bad_response', 200);
  return id;
}

export class CopyBackGraphClient extends GraphClient {
  /** The Exchange id of a copy we made earlier for this cmail message, or null. */
  async findCopy(objectId: string, marker: string): Promise<string | null> {
    if (!MARKER.test(marker)) throw new GraphError('bad_response', 0);
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq ${odataString(COPYBACK_MARKER_PROPERTY)} and ep/value eq ${odataString(marker)})`;
    const body = await this.graphJson(`${userPath(objectId)}/messages?$filter=${encodeURIComponent(filter)}&$select=id&$top=1`, { method: 'GET' });
    return firstId(body);
  }

  /** The Exchange id of a message with this Message-ID already in the mailbox, or null. */
  async findByInternetMessageId(objectId: string, internetMessageId: string): Promise<string | null> {
    if (!internetMessageId || internetMessageId.length > 998 || /[\u0000-\u001f\u007f]/.test(internetMessageId)) return null;
    const filter = `internetMessageId eq ${odataString(internetMessageId)}`;
    const body = await this.graphJson(`${userPath(objectId)}/messages?$filter=${encodeURIComponent(filter)}&$select=id&$top=1`, { method: 'GET' });
    return firstId(body);
  }

  /** Creates the copy in a well-known folder and returns its Exchange id. */
  async createMessage(objectId: string, folder: string, message: string): Promise<string> {
    if (!WELL_KNOWN.has(folder)) throw new GraphError('bad_response', 0);
    const body = await this.graphJson(`${userPath(objectId)}/mailFolders/${folder}/messages`, { method: 'POST', body: message });
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id || id.length > 512) throw new GraphError('bad_response', 201);
    return id;
  }

  async markUnread(objectId: string, messageId: string): Promise<void> {
    if (!messageId || messageId.length > 512) throw new GraphError('bad_response', 0);
    await this.graphJson(`${userPath(objectId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ isRead: false }),
    });
  }
}
