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
//    Each round runs fetch -> (sweep) -> pauses. Pauses are queued until the
//    end and pass the mass-pause brake first: a round that would pause too
//    many linked people, or a reconciliation that returned nothing, is held
//    until a manager approves it (or presses Sync now to start over).
// 5. Does bounded work (pages fetched, objects applied, D1 statements and
//    wall time) and saves its place after every step, so a stop at any point
//    resumes cleanly on the next tick. Replays are harmless: every write is
//    keyed on the Entra object id and guarded.
import {
  M365_BRAKE_MIN_PAUSES,
  emptyCounts,
  loadM365SyncSwitch,
  m365SyncConfig,
  parseM365SyncState,
  type M365Brake,
  type M365PendingEntry,
  type M365Round,
  type M365RoundKind,
  type M365RoundMode,
  type M365SyncConfig,
  type M365SyncEnv,
  type M365SyncState,
} from '@cmail/shared/m365-sync';
import { applyEntries, applyQueuedPause, linkedPeopleInScope, sweepUnseen, type ApplyContext } from './apply';
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
/** A round older than this is abandoned and started again (a held round waits longer). */
const ROUND_MAX_AGE_MS = DAY_MS;
const HELD_ROUND_MAX_AGE_MS = 7 * DAY_MS;
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
  | { status: 'off' | 'busy' | 'not_installed' | 'not_configured' | 'idle' | 'backoff' | 'held' }
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
    pauseQueue: [],
    fetched: 0,
    brake: null,
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

/**
 * The mass-pause brake. Holds when the round would pause at least
 * M365_BRAKE_MIN_PAUSES people and more than `maxPercent` of the linked
 * people, or when a reconciliation returned no directory objects at all
 * while people are linked (a wrong tenant, a broken permission or an empty
 * response must never look like "everyone left").
 */
export function brakeCheck(round: M365Round, linked: number, maxPercent: number): M365Brake | null {
  const pauses = round.pauseQueue.length;
  const percent = linked ? Math.round((pauses / linked) * 100) : 0;
  if (round.kind === 'reconcile' && round.fetched === 0 && linked > 0) {
    return { reason: 'empty_result', pauses, linked, percent };
  }
  if (pauses >= M365_BRAKE_MIN_PAUSES && pauses * 100 > linked * maxPercent) {
    return { reason: 'too_many_pauses', pauses, linked, percent };
  }
  return null;
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
    const cls = classify(user, config.mailDomain, groups, memberships.get(user.id) ?? memberships.get(id) ?? null, config.mailboxPlanIds);
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
    brake: round.brake,
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
    const requested = Boolean(toggle.requestedAt) && toggle.requestedAt !== state.handledRequestAt;
    if (state.round) {
      // Older rounds may predate the brake fields.
      state.round.pauseQueue ??= [];
      state.round.fetched ??= 0;
      state.round.brake ??= null;
      const held = state.round.phase === 'held';
      const maxAge = held ? HELD_ROUND_MAX_AGE_MS : ROUND_MAX_AGE_MS;
      // Drop the round when the mode changed, it went stale (its saved page
      // links may have expired), or a manager pressed Sync now on a held round.
      if (state.round.mode !== mode || age(startedAt, state.round.startedAt) > maxAge || (held && requested)) state.round = null;
    }
    if (state.round?.phase === 'held') {
      if (toggle.approvedRound !== state.round.id) {
        state.lastResult = 'held';
        await saveState(db, state);
        return { status: 'held' };
      }
      // A manager approved this exact round: apply its pauses.
      state.round.phase = 'pauses';
    }
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
    const withinBudget = () => now() - startedAt < budgets.timeMs && d1Ops < budgets.d1;
    const context = (round: M365Round): ApplyContext => ({ db, round, ops: 0, newId, now });

    while (state.round && withinBudget()) {
      const current = state.round;
      if (current.phase === 'held') break;
      if (current.pending.length) {
        const chunk = current.pending.slice(0, budgets.chunk);
        const ctx = context(current);
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
        // If this throttles, the page is not saved and is fetched again on
        // resume (one extra page request; nothing is applied twice).
        const memberships = needCheck.length ? await graph.memberGroups(needCheck, groupIds) : new Map<string, Set<string>>();
        current.pending = toPending(page.users, config, memberships);
        current.fetched += page.users.length;
        current.nextLink = page.nextLink;
        if (page.deltaLink) current.finalDeltaLink = page.deltaLink;
      } else if (current.phase === 'fetch' || current.phase === 'sweep') {
        if (current.kind === 'reconcile') {
          current.phase = 'sweep';
          const ctx = context(current);
          const swept = await sweepUnseen(ctx, budgets.chunk);
          d1Ops += ctx.ops;
          if (swept) {
            await saveState(db, state);
            d1Ops += 1;
            continue;
          }
        }
        // All objects applied: check the brake before any pause.
        const ctx = context(current);
        const linked = await linkedPeopleInScope(ctx);
        d1Ops += ctx.ops;
        current.brake = brakeCheck(current, linked, config.maxPausePercent);
        if (current.brake && current.mode === 'live') {
          current.phase = 'held';
          console.warn('Microsoft 365 sync: round held by the mass-pause brake', { reason: current.brake.reason, pauses: current.brake.pauses, linked });
          await saveState(db, state);
          d1Ops += 1;
          break;
        }
        current.phase = 'pauses';
      } else if (current.phase === 'pauses' && current.pauseQueue.length) {
        const chunk = current.pauseQueue.slice(0, budgets.chunk);
        const ctx = context(current);
        try {
          for (const item of chunk) {
            await applyQueuedPause(ctx, item);
            // Dequeued only once applied; a retry re-checks and is harmless.
            current.pauseQueue = current.pauseQueue.slice(1);
          }
        } finally {
          d1Ops += ctx.ops;
        }
      } else {
        finishRound(state, current, now());
        finished = true;
      }
      d1Ops += 1;
      await saveState(db, state);
    }

    state.backoffStreak = 0;
    state.lastResult = state.round?.phase === 'held' ? 'held' : state.round ? 'running' : 'ok';
    await saveState(db, state);
    if (state.round?.phase === 'held') return { status: 'held' };
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
