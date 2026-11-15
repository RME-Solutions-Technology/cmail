// Expands mail-enabled security groups that were granted Full Access or Send
// As, using Microsoft Graph with the existing (read-only) directory sync app:
// GET /groups/{id}/transitiveMembers/microsoft.graph.user?$select=id&$count=true
// with ConsistencyLevel: eventual (an OData cast on directory objects is an
// advanced query: https://learn.microsoft.com/en-us/graph/aad-advanced-queries)
// (application permission GroupMember.Read.All, which the Microsoft 365 sync
// already uses for its scope and shared groups).
// https://learn.microsoft.com/en-us/graph/api/group-list-transitivemembers
// Only user object ids come back; nested groups are flattened by Graph.
import { GRAPH_ROOT, GraphClient, GraphError, isGraphUrl } from '../m365-sync/graph';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Members kept per group: beyond this the group counts as not expandable. */
export const MAX_GROUP_MEMBERS = 20_000;
/** Required with the OData cast (advanced query). Also sent on nextLink pages. */
export const GROUP_QUERY_HEADERS: Readonly<Record<string, string>> = { ConsistencyLevel: 'eventual' };

export class PermsGraphClient extends GraphClient {
  /**
   * All user members of a group, nested groups included. Throws GraphError
   * (unauthorized for a missing permission, throttled, ...). A group with more
   * than MAX_GROUP_MEMBERS members throws 'bad_response'.
   */
  async transitiveUserMembers(groupId: string, maxRequests = 30): Promise<string[]> {
    if (!GUID.test(groupId)) throw new GraphError('bad_response', 0);
    let url: string | null = `${GRAPH_ROOT}groups/${groupId}/transitiveMembers/microsoft.graph.user?$select=id&$top=999&$count=true`;
    const members = new Set<string>();
    let pages = 0;
    while (url) {
      if (pages >= maxRequests) throw new GraphError('throttled', 0, null);
      pages += 1;
      const body = await this.graphJson(url, { method: 'GET', headers: GROUP_QUERY_HEADERS }) as Record<string, unknown> | null;
      if (!body || !Array.isArray(body.value)) throw new GraphError('bad_response', 200);
      for (const item of body.value as unknown[]) {
        const id = (item as { id?: unknown } | null)?.id;
        if (typeof id === 'string' && GUID.test(id)) members.add(id.toLowerCase());
      }
      if (members.size > MAX_GROUP_MEMBERS) throw new GraphError('bad_response', 200);
      const next = body['@odata.nextLink'];
      if (next === undefined || next === null) url = null;
      else if (isGraphUrl(next)) url = next;
      else throw new GraphError('bad_response', 200);
    }
    return [...members];
  }
}
