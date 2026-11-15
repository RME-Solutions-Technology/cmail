// Microsoft 365 alias import for the Exchange mirror (docs/exchange-mirror.md,
// "Aliases"). Off by default: a manager turns it on in Admin > Exchange
// mirror, and it also needs the Microsoft 365 sync on and out of dry run.
//
// Each run (at most once per M365_SYNC_INTERVAL_MINUTES, on the sync's cron)
// reads every user's proxyAddresses from Microsoft Graph (the same read-only
// app and User.Read.All permission as the sync), keeps the smtp: entries on
// MAIL_DOMAIN of objects the sync has linked to a cmail mailbox, and makes
// mailbox_aliases match. Rules:
// - An alias is never another mailbox's own address (any status): such an
//   address is refused and counted as a conflict. The database enforces the
//   same (migration 0027 triggers).
// - An address two linked objects both claim is refused for both.
// - An address moves to another mailbox only when Microsoft 365 now lists it
//   on that object and not on the old one (a full listing shows that).
// - Nothing is removed unless the whole listing was read, and a listing that
//   yields no aliases at all while some are held removes nothing (held).
// - A run that would remove more than 20 percent of held aliases (and at
//   least 5) applies its additions and moves but holds the removals until a
//   manager approves them in Admin; the run counts as held, not successful.
// - The mirror uses aliases only while the import is on and its last
//   successful run is under 3 days old (aliasesUsable).
// - Only the Exchange mirror reads aliases; normal inbound delivery does not.
import {
  loadM365SyncSwitch,
  m365SyncConfig,
} from '@cmail/shared/m365-sync';
import {
  ALIAS_BRAKE_MIN,
  ALIAS_BRAKE_PERCENT,
  M365_ALIAS_SYNC_SETTING_APPROVE_REMOVALS,
  emptyAliasCounts,
  loadAliasSyncSwitch,
  type AliasSyncCounts,
  type AliasSyncState,
} from '@cmail/shared/exchange-mirror';
import { ALIAS_USERS_URL, GraphClient, GraphError } from './graph';
import type { M365SyncWorkerEnv } from './sync';

const LEASE_MS = 10 * 60 * 1000;
const MAX_PAGES = 50;
const MAX_ALIASES = 20_000;
const BATCH = 50;
const IN_CHUNK = 90;
const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface AliasSyncDeps {
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type AliasTickResult =
  | { status: 'off' | 'sync_off' | 'idle' | 'busy' | 'not_installed' | 'not_configured' | 'error' }
  | { status: 'worked' | 'dry_run' | 'held'; counts: AliasSyncCounts };

interface LinkRow {
  object_id: string;
  mailbox_id: string | null;
}

/** The on-domain smtp addresses in a proxyAddresses list, lower case, unique. */
export function smtpAliases(proxyAddresses: readonly string[], mailDomain: string): string[] {
  const out = new Set<string>();
  for (const entry of proxyAddresses) {
    const match = /^smtp:(.+)$/i.exec(entry.trim());
    if (!match) continue;
    const address = (match[1] || '').trim().toLowerCase();
    if (address.length > 320 || !ADDRESS.test(address)) continue;
    if (address.slice(address.lastIndexOf('@') + 1) !== mailDomain) continue;
    out.add(address);
  }
  return [...out];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

async function saveState(db: D1Database, now: number, state: Omit<AliasSyncState, 'lastRunAt' | 'lastOkAt'>): Promise<void> {
  // last_ok_at moves only for a run that read everything and applied it in full.
  await db.prepare(
    `UPDATE m365_alias_sync_state
     SET state = ?, last_run_at = ?, last_ok_at = CASE WHEN ? = 1 THEN ? ELSE last_ok_at END, lease_until = 0, updated_at = datetime('now')
     WHERE id = 1`,
  ).bind(JSON.stringify(state), now, state.lastResult === 'ok' ? 1 : 0, now).run();
}

/**
 * One cron tick. Off: one org_settings read and nothing else.
 */
export async function runAliasSyncTick(env: M365SyncWorkerEnv, deps: AliasSyncDeps = {}): Promise<AliasTickResult> {
  const db = env.DB;
  if (!await loadAliasSyncSwitch(db).catch(() => false)) return { status: 'off' };
  const sync = await loadM365SyncSwitch(db).catch(() => null);
  if (!sync?.enabled) return { status: 'sync_off' };
  const now = (deps.now ?? Date.now)();
  const check = m365SyncConfig(env);
  const intervalMs = (check.configured ? check.config.intervalMinutes : 60) * 60 * 1000;

  try {
    await db.prepare(`INSERT OR IGNORE INTO m365_alias_sync_state (id, state, lease_until, last_run_at) VALUES (1, '{}', 0, 0)`).run();
  } catch {
    return { status: 'not_installed' };
  }
  const lease = await db.prepare(
    `UPDATE m365_alias_sync_state SET lease_until = ? WHERE id = 1 AND lease_until <= ? AND last_run_at <= ?`,
  ).bind(now + LEASE_MS, now, now - intervalMs).run();
  if (Number(lease.meta?.changes ?? 0) === 0) {
    const row = await db.prepare('SELECT lease_until FROM m365_alias_sync_state WHERE id = 1').first<{ lease_until: number }>();
    return { status: row && Number(row.lease_until) > now ? 'busy' : 'idle' };
  }

  if (!check.configured) {
    await saveState(db, now, { lastResult: 'not_configured', lastError: null, counts: null });
    return { status: 'not_configured' };
  }
  const config = check.config;

  try {
    // 1. Read every user's proxyAddresses (whole listing or nothing).
    const graph = new GraphClient({
      tenantId: config.tenantId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      fetcher: deps.fetcher,
      sleep: deps.sleep,
      now: deps.now,
    });
    const byObject = new Map<string, string[]>();
    let url: string | null = ALIAS_USERS_URL;
    let pages = 0;
    let usersSeen = 0;
    while (url) {
      if (pages >= MAX_PAGES) throw new GraphError('bad_response', 200);
      const page = await graph.proxyAddressPage(url);
      pages += 1;
      usersSeen += page.users.length;
      for (const user of page.users) {
        const aliases = smtpAliases(user.proxyAddresses, config.mailDomain);
        if (aliases.length) byObject.set(user.id.toLowerCase(), aliases);
      }
      url = page.nextLink;
    }

    // 2. Which cmail mailbox each linked object feeds (a person's own
    //    personal mailbox, only when there is exactly one; a shared mailbox).
    const { results: links } = await db.prepare(
      `SELECT l.object_id AS object_id,
              CASE WHEN l.kind = 'shared' THEN l.mailbox_id
                   ELSE (SELECT CASE WHEN COUNT(*) = 1 THEN MAX(m.id) END FROM mailboxes m
                         WHERE m.owner_user_id = l.user_id AND m.type = 'personal')
              END AS mailbox_id
       FROM m365_sync_links l
       WHERE l.source_state = 'in_scope'`,
    ).all<LinkRow>();
    const mailboxOf = new Map<string, string>();
    for (const link of links ?? []) if (link.mailbox_id) mailboxOf.set(link.object_id.toLowerCase(), link.mailbox_id);

    // 3. Desired address -> mailbox, refusing double claims.
    const counts = emptyAliasCounts();
    const desired = new Map<string, { mailboxId: string; objectId: string }>();
    const doubled = new Set<string>();
    for (const [objectId, aliases] of byObject) {
      const mailboxId = mailboxOf.get(objectId);
      if (!mailboxId) {
        counts.unlinked += 1;
        continue;
      }
      for (const address of aliases) {
        const existing = desired.get(address);
        if (existing && existing.mailboxId !== mailboxId) doubled.add(address);
        else desired.set(address, { mailboxId, objectId });
      }
    }
    for (const address of doubled) desired.delete(address);
    counts.conflicts += doubled.size;
    if (desired.size > MAX_ALIASES) throw new GraphError('bad_response', 200);

    // 4. Never another mailbox's own address (this also drops each mailbox's
    //    own primary SMTP address, which Exchange lists too).
    const addresses = [...desired.keys()];
    for (const slice of chunks(addresses, IN_CHUNK)) {
      const { results } = await db.prepare(
        `SELECT address, id FROM mailboxes WHERE address IN (${slice.map(() => '?').join(', ')})`,
      ).bind(...slice).all<{ address: string; id: string }>();
      for (const row of results ?? []) {
        const wanted = desired.get(row.address);
        if (wanted && wanted.mailboxId !== row.id) counts.conflicts += 1;
        desired.delete(row.address);
      }
    }

    // 5. Diff with what is held.
    const { results: heldRows } = await db.prepare(
      `SELECT address, mailbox_id FROM mailbox_aliases WHERE source = 'm365'`,
    ).all<{ address: string; mailbox_id: string }>();
    const held = new Map((heldRows ?? []).map((row) => [row.address, row.mailbox_id]));
    const inserts: Array<[string, { mailboxId: string; objectId: string }]> = [];
    const moves: Array<[string, { mailboxId: string; objectId: string }]> = [];
    for (const entry of desired) {
      const current = held.get(entry[0]);
      if (current === undefined) inserts.push(entry);
      else if (current !== entry[1].mailboxId) moves.push(entry);
    }
    const removes = [...held.keys()].filter((address) => !desired.has(address));
    counts.added = inserts.length;
    counts.moved = moves.length;
    counts.removed = removes.length;
    counts.total = desired.size;

    if ((usersSeen === 0 || desired.size === 0) && held.size > 0) {
      // A listing that suddenly holds nothing is more likely a fault than a fact.
      counts.removed = 0;
      counts.total = held.size;
      await saveState(db, now, { lastResult: 'held', lastError: 'empty_result', counts });
      return { status: 'held', counts };
    }
    if (sync.dryRun) {
      await saveState(db, now, { lastResult: 'dry_run', lastError: null, counts });
      return { status: 'dry_run', counts };
    }

    // Mass-removal brake: a listing that drops many aliases at once is more
    // likely partial than real. Additions and moves still apply; removals
    // wait until a manager approves them in Admin (one run).
    const brakeLimit = Math.max(ALIAS_BRAKE_MIN, Math.floor((held.size * ALIAS_BRAKE_PERCENT) / 100));
    let applyRemoves = removes;
    if (removes.length > brakeLimit) {
      const approval = await db.prepare('SELECT value FROM org_settings WHERE key = ?')
        .bind(M365_ALIAS_SYNC_SETTING_APPROVE_REMOVALS).first<{ value: string }>();
      if (approval?.value === 'true') {
        await db.prepare(`UPDATE org_settings SET value = 'false', updated_at = datetime('now') WHERE key = ?`)
          .bind(M365_ALIAS_SYNC_SETTING_APPROVE_REMOVALS).run();
      } else {
        applyRemoves = [];
        counts.heldRemovals = removes.length;
        counts.removed = 0;
        counts.total = desired.size + removes.length;
      }
    }

    // 6. Apply: removals first, so an address that moved is free again.
    const statements: D1PreparedStatement[] = [];
    for (const address of applyRemoves) {
      statements.push(db.prepare(`DELETE FROM mailbox_aliases WHERE address = ? AND source = 'm365'`).bind(address));
    }
    for (const [address, target] of [...moves, ...inserts]) {
      statements.push(db.prepare(
        `INSERT INTO mailbox_aliases (address, mailbox_id, source, object_id)
         SELECT ?, ?, 'm365', ? WHERE NOT EXISTS (SELECT 1 FROM mailboxes WHERE address = ?)
         ON CONFLICT(address) DO UPDATE SET mailbox_id = excluded.mailbox_id, object_id = excluded.object_id, updated_at = datetime('now')`,
      ).bind(address, target.mailboxId, target.objectId, address));
    }
    for (const slice of chunks(statements, BATCH)) await db.batch(slice);
    if (inserts.length || moves.length || applyRemoves.length || counts.heldRemovals) {
      await db.prepare(
        `INSERT INTO audit_log (event_id, timestamp, actor_id, actor_role, event_type, target, detail)
         VALUES (?, datetime('now'), NULL, 'system', 'm365_sync.aliases_changed', 'mailbox_aliases', ?)`,
      ).bind(crypto.randomUUID(), `Microsoft 365 alias import: ${inserts.length} added, ${moves.length} moved, ${applyRemoves.length} removed, ${counts.conflicts} refused (conflict)${counts.heldRemovals ? `, ${counts.heldRemovals} removals held for approval` : ''}`).run();
    }
    if (counts.heldRemovals) {
      await saveState(db, now, { lastResult: 'held', lastError: 'mass_removal', counts });
      return { status: 'held', counts };
    }
    await saveState(db, now, { lastResult: 'ok', lastError: null, counts });
    return { status: 'worked', counts };
  } catch (caught) {
    const code = caught instanceof GraphError ? caught.code : 'error';
    await saveState(db, now, { lastResult: 'error', lastError: String(code).slice(0, 64), counts: null }).catch(() => undefined);
    return { status: 'error' };
  }
}
