// Scheduled driver for the Microsoft 365 mailbox sync (docs/m365-sync.md).
//
// Every cron tick:
// 1. Reads the Admin switch. Off = return at once: no Graph call, no write.
// 2. Takes a short lease on the single m365_sync_state row, so two
//    overlapping invocations never run a round together.
// 3. Checks the Worker configuration; missing settings are recorded as
//    'not_configured' (names only) instead of failing.
// 4. Continues the round in progress, or starts one when due:
//    - reconcile: a fresh users/delta enumeration of the whole directory, then
//      a sweep of linked objects it never returned. Daily, after "Sync now",
//      after a resync-required answer, when the delta link is near its
//      7-day limit, and always in dry run;
//    - delta: the saved delta link, every M365_SYNC_INTERVAL_MINUTES.
// 5. Does bounded work (pages fetched, objects applied, D1 statements and
//    wall time) and saves its place after every step, so a stop at any point
//    resumes cleanly on the next tick. Replays are harmless: every write is
//    keyed on the Entra object id and guarded.
import {
  emptyCounts,
  loadM365SyncSwitch,
  m365SyncConfig,
  parseM365SyncState,
  type M365PendingEntry,
  type M365Round,
  type M365RoundKind,
  type M365RoundMode,
  type M365SyncConfig,
  type M365SyncEnv,
  type M365SyncState,
} from '@cmail/shared/m365-sync';
import { applyEntries, sweepUnseen, type ApplyContext } from './apply';
import { classify, needsGroupCheck } from './classify';
import { GraphClient, GraphError, INITIAL_DELTA_URL, type GraphUser } from './graph';

export const M365_SYNC_CRON = '*/15 * * * *';

const LEASE_SECONDS = 10 * 60;
/** No new step starts after this much wall time in one tick. */
const TICK_TIME_BUDGET_MS = 60_000;
/** No new step starts after this many D1 statements: far inside the Workers Paid subrequest limit (10,000 per invocation, D1 included). */
const TICK_D1_BUDGET = 600;
/** No new page is fetched after this many Graph requests in one tick. */
const TICK_GRAPH_BUDGET = 60;
/** Objects applied per step. */
const APPLY_CHUNK = 25;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Graph delta tokens for directory objects last seven days; refresh well before. */
const DELTA_LINK_MAX_AGE_MS = 6 * DAY_MS;
/** A round older than this is abandoned and started again. */
const ROUND_MAX_AGE_MS = DAY_MS;
const MAX_BACKOFF_SECONDS = 60 * 60;
const AUTH_BACKOFF_SECONDS = 60 * 60;
const MAX_RESTARTS = 2;

export interface M365SyncWorkerEnv extends M365SyncEnv {
  DB: D1Database;
}

export interface M365SyncDeps {
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  newId?: () => string;
  /** Tests shrink the budgets to prove resumability. */
  budgets?: Partial<{ timeMs: number; d1: number; graph: number; chunk: number }>;
}

export type M365TickResult =
  | { status: 'off' | 'busy' | 'not_installed' | 'not_configured' | 'idle' | 'backoff' }
  | { status: 'worked'; round: M365RoundKind | null; mode: M365RoundMode | null; finished: boolean }
  | { status: 'error'; code: string };

const iso = (ms: number) => new Date(ms).toISOString();
const age = (now: number, at: string | null) => (at ? now - Date.parse(at) : Number.POSITIVE_INFINITY);

function newRound(kind: M365RoundKind, mode: M365RoundMode, now: number, id: string, restarts = 0): M365Round {
  return {
    id,
    kind,
    mode,
    phase: 'fetch',
    nextLink: null,
    finalDeltaLink: null,
    pending: [],
    startedAt: iso(now),
    counts: emptyCounts(),
    report: [],
    restarts,
  };
}

/** Which round to start now, if any. */
export function dueRound(
  state: M365SyncState,
  options: { mode: M365RoundMode; requested: boolean; intervalMinutes: number; now: number },
): M365RoundKind | null {
  const { mode, requested, intervalMinutes, now } = options;
  if (requested) return 'reconcile';
  const interval = intervalMinutes * 60_000;
  if (mode === 'dry_run') {
    return state.lastReconcileMode !== 'dry_run' || age(now, state.lastReconcileAt) >= interval ? 'reconcile' : null;
  }
  if (!state.deltaLink || state.lastReconcileMode !== 'live') return 'reconcile';
  if (age(now, state.deltaLinkAt) >= DELTA_LINK_MAX_AGE_MS || age(now, state.lastReconcileAt) >= DAY_MS) return 'reconcile';
  return age(now, state.lastDeltaAt) >= interval ? 'delta' : null;
}

async function saveState(db: D1Database, state: M365SyncState): Promise<void> {
  await db.prepare(`UPDATE m365_sync_state SET state = ?, updated_at = datetime('now') WHERE id = 1`)
    .bind(JSON.stringify(state)).run();
}

function toPending(users: GraphUser[], config: M365SyncConfig, memberships: Map<string, Set<string>>): M365PendingEntry[] {
  const groups = { scope: config.scopeGroupId, shared: config.sharedGroupId };
  const byId = new Map<string, M365PendingEntry>();
  for (const user of users) {
    if (typeof user.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(user.id)) continue;
    const id = user.id.toLowerCase();
    const cls = classify(user, config.mailDomain, groups, memberships.get(user.id) ?? memberships.get(id) ?? null);
    // A page may repeat an object (delta replays); the last copy wins.
    byId.delete(id);
    byId.set(id, cls.kind === 'out'
      ? { id, kind: 'out', address: cls.address, displayName: '', reason: cls.reason }
      : { id, kind: cls.kind, address: cls.address, displayName: cls.displayName, reason: '' });
  }
  return [...byId.values()];
}

function finishRound(state: M365SyncState, round: M365Round, now: number): void {
  const finishedAt = iso(now);
  state.lastRound = {
    kind: round.kind,
    mode: round.mode,
    startedAt: round.startedAt,
    finishedAt,
    counts: round.counts,
    report: round.report,
  };
  if (round.mode === 'live') {
    state.deltaLink = round.finalDeltaLink;
    state.deltaLinkAt = finishedAt;
    state.lastDeltaAt = finishedAt;
  }
  if (round.kind === 'reconcile') {
    state.lastReconcileAt = finishedAt;
    state.lastReconcileMode = round.mode;
  }
  state.round = null;
  state.lastError = null;
}

function backoff(state: M365SyncState, now: number, seconds: number | null): void {
  const wait = seconds ?? Math.min(MAX_BACKOFF_SECONDS, 60 * 2 ** Math.min(state.backoffStreak, 6));
  state.backoffStreak += 1;
  state.backoffUntil = iso(now + Math.max(1, Math.min(MAX_BACKOFF_SECONDS, wait)) * 1000);
}

export async function runM365SyncTick(env: M365SyncWorkerEnv, deps: M365SyncDeps = {}): Promise<M365TickResult> {
  const db = env.DB;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const budgets = { timeMs: TICK_TIME_BUDGET_MS, d1: TICK_D1_BUDGET, graph: TICK_GRAPH_BUDGET, chunk: APPLY_CHUNK, ...deps.budgets };

  const toggle = await loadM365SyncSwitch(db);
  if (!toggle.enabled) return { status: 'off' };

  const startedAt = now();
  try {
    await db.prepare(`INSERT OR IGNORE INTO m365_sync_state (id, state, lease_until) VALUES (1, '{}', 0)`).run();
  } catch {
    // Migration 0022 has not been applied to this database.
    return { status: 'not_installed' };
  }
  const nowSeconds = Math.floor(startedAt / 1000);
  const lease = await db.prepare(
    `UPDATE m365_sync_state SET lease_until = ? WHERE id = 1 AND lease_until < ?`,
  ).bind(nowSeconds + LEASE_SECONDS, nowSeconds).run();
  if (!lease.meta.changes) return { status: 'busy' };

  const row = await db.prepare('SELECT state FROM m365_sync_state WHERE id = 1').first<{ state: string }>();
  const state = parseM365SyncState(row?.state);
  state.lastTickAt = iso(startedAt);

  try {
    const check = m365SyncConfig(env);
    if (!check.configured) {
      state.lastResult = 'not_configured';
      state.lastError = { code: 'not_configured', at: iso(startedAt) };
      await saveState(db, state);
      return { status: 'not_configured' };
    }
    const config = check.config;

    if (state.backoffUntil && Date.parse(state.backoffUntil) > startedAt) {
      await saveState(db, state);
      return { status: 'backoff' };
    }
    state.backoffUntil = null;

    const mode: M365RoundMode = toggle.dryRun ? 'dry_run' : 'live';
    if (state.round && (state.round.mode !== mode || age(startedAt, state.round.startedAt) > ROUND_MAX_AGE_MS)) {
      // Mode changed or the round went stale (for example the switch was off
      // for days): its saved page links may have expired. Start again.
      state.round = null;
    }
    const requested = Boolean(toggle.requestedAt) && toggle.requestedAt !== state.handledRequestAt;
    if (!state.round) {
      const kind = dueRound(state, { mode, requested, intervalMinutes: config.intervalMinutes, now: startedAt });
      if (requested) state.handledRequestAt = toggle.requestedAt;
      if (!kind) {
        state.lastResult = 'ok';
        await saveState(db, state);
        return { status: 'idle' };
      }
      state.round = newRound(kind, mode, startedAt, newId());
      if (kind === 'delta') state.round.nextLink = state.deltaLink;
    }

    const graph = new GraphClient({
      tenantId: config.tenantId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      fetcher: deps.fetcher,
      sleep: deps.sleep,
      now,
    });
    const groupIds = [config.scopeGroupId, config.sharedGroupId].filter((id): id is string => Boolean(id));
    let d1Ops = 0;
    let finished = false;
    const round = () => state.round!;
    const withinBudget = () => now() - startedAt < budgets.timeMs && d1Ops < budgets.d1;

    while (state.round && withinBudget()) {
      const current = round();
      if (current.pending.length) {
        const chunk = current.pending.slice(0, budgets.chunk);
        const ctx: ApplyContext = { db, round: current, ops: 0, newId };
        await applyEntries(ctx, chunk);
        d1Ops += ctx.ops;
        current.pending = current.pending.slice(chunk.length);
      } else if (current.phase === 'fetch' && current.finalDeltaLink === null) {
        if (graph.requests >= budgets.graph) break;
        let page;
        try {
          page = await graph.deltaPage(current.nextLink ?? INITIAL_DELTA_URL);
        } catch (caught) {
          if (caught instanceof GraphError && caught.code === 'resync_required' && current.restarts < MAX_RESTARTS) {
            // 410 Gone / syncStateNotFound: the token is unusable. Drop it and
            // run a full reconciliation from scratch.
            state.deltaLink = null;
            state.deltaLinkAt = null;
            state.round = newRound('reconcile', mode, now(), newId(), current.restarts + 1);
            console.warn('Microsoft 365 sync: delta token not usable, starting a full reconciliation');
            await saveState(db, state);
            continue;
          }
          throw caught;
        }
        const needCheck = groupIds.length
          ? page.users.filter((user) => needsGroupCheck(user, config.mailDomain, { scope: config.scopeGroupId, shared: config.sharedGroupId })).map((user) => user.id)
          : [];
        const memberships = needCheck.length ? await graph.memberGroups(needCheck, groupIds) : new Map<string, Set<string>>();
        current.pending = toPending(page.users, config, memberships);
        current.nextLink = page.nextLink;
        if (page.deltaLink) current.finalDeltaLink = page.deltaLink;
      } else if (current.kind === 'reconcile') {
        current.phase = 'sweep';
        const ctx: ApplyContext = { db, round: current, ops: 0, newId };
        const swept = await sweepUnseen(ctx, budgets.chunk);
        d1Ops += ctx.ops;
        if (!swept) {
          finishRound(state, current, now());
          finished = true;
        }
      } else {
        finishRound(state, current, now());
        finished = true;
      }
      d1Ops += 1;
      await saveState(db, state);
    }

    state.backoffStreak = 0;
    state.lastResult = state.round ? 'running' : 'ok';
    await saveState(db, state);
    const last = state.round ?? state.lastRound;
    return { status: 'worked', round: last?.kind ?? null, mode: last?.mode ?? null, finished };
  } catch (caught) {
    const at = now();
    let code = 'internal';
    if (caught instanceof GraphError) {
      code = caught.code;
      if (caught.code === 'throttled' || caught.code === 'network') {
        backoff(state, at, caught.retryAfterSeconds);
        state.lastResult = 'backoff';
      } else if (caught.code === 'unauthorized' || caught.code === 'credentials_rejected') {
        backoff(state, at, AUTH_BACKOFF_SECONDS);
        state.lastResult = 'error';
      } else {
        backoff(state, at, null);
        state.lastResult = 'error';
      }
    } else {
      backoff(state, at, null);
      state.lastResult = 'error';
    }
    state.lastError = { code, at: iso(at) };
    // Codes only: no response bodies, tokens or addresses.
    console.error('Microsoft 365 sync tick failed', { code, status: caught instanceof GraphError ? caught.status : 0 });
    try {
      await saveState(db, state);
    } catch {
      // The lease below still expires on its own.
    }
    return { status: 'error', code };
  } finally {
    await db.prepare('UPDATE m365_sync_state SET lease_until = 0 WHERE id = 1').run().catch(() => undefined);
  }
}

/** Read-only check for Admin over the private service binding: setting names only, never values. */
export function m365SyncConfigDiagnostic(env: M365SyncEnv): { configured: boolean; problems: string[] } {
  const check = m365SyncConfig(env);
  return check.configured ? { configured: true, problems: [] } : { configured: false, problems: check.problems };
}
