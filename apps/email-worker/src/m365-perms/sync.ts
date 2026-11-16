// Scheduled driver for shared mailbox access from Exchange Online
// (docs/m365-mailbox-permissions.md). Runs on the existing */15 cron.
//
// Every tick:
// 1. Reads the Admin switch. Off = return at once: no collector, no Graph,
//    no write, nothing else read.
// 2. Takes a short lease on the single m365_perm_state row.
// 3. Checks the Worker configuration (names only on failure).
// 4. Moves the round on one phase at a time, saving after each step:
//    collecting -> groups -> diff -> apply (-> held) -> finished.
//    A new round starts when due (M365_PERMS_INTERVAL_HOURS, default daily)
//    or when a manager pressed "Sync access now".
// 5. Any failure (collector, timeout, bad snapshot, Graph) ends the round
//    with nothing changed, counts a consecutive failure, backs off and tries
//    again later. Admin alerts after M365_PERMS_FAILURE_ALERT failures.
// The switch is read again before every write step, so turning it off stops
// a round in progress before its next write.
// With the separate "include managers" switch on (off by default), unlinked
// manager accounts are matched to Entra users by primary SMTP address once
// per round, before the diff (managers.ts).
import {
  M365_PERMS_FAILURE_ALERT,
  M365_PERMS_REMOVAL_LIMIT,
  M365_PERMS_REPORT_LIMIT,
  emptyM365PermsCounts,
  loadM365PermsSwitch,
  m365PermsConfig,
  parseM365PermsState,
  type M365PermsEnv,
  type M365PermsMode,
  type M365PermsRound,
  type M365PermsState,
} from '@cmail/shared/m365-perms';
import { m365SyncConfig, type M365SyncEnv } from '@cmail/shared/m365-sync';
import { GraphError } from '../m365-sync/graph';
import {
  applyOp,
  clearGroupMembers,
  loadAssignments,
  loadGroupMembers,
  loadLedger,
  loadPersonLinks,
  loadReleased,
  loadSharedLinks,
  reportOp,
  saveGroupMembers,
  type PermsApplyContext,
} from './apply';
import { beginCollect, discardCollect, readCollect } from './collector';
import { brakeCheck, computeDiff, type DiffOp, type PersonLink } from './diff';
import { PermsGraphClient } from './groups';
import { MAX_MANAGER_REPORT_ROWS, loadManagerLinks, loadUnlinkedLedgerAccounts, resolveManagerMatches } from './managers';
import { groupTrustees, mergeBatches, parseSnapshot, type PermissionSnapshot } from './snapshot';

const LEASE_SECONDS = 10 * 60;
const TICK_TIME_BUDGET_MS = 60_000;
/** D1 statements per tick: far inside the Workers Paid subrequest limit. */
const TICK_D1_BUDGET = 600;
const TICK_GRAPH_BUDGET = 60;
const HOUR_MS = 60 * 60 * 1000;
const COLLECT_TIMEOUT_MS = 25 * 60 * 1000;
/** A held round waits at most this long: its snapshot must stay under the 36-hour limit. */
const HELD_ROUND_MAX_AGE_MS = 30 * HOUR_MS;
const ROUND_MAX_AGE_MS = 24 * HOUR_MS;
const MAX_BACKOFF_MS = 24 * HOUR_MS;
/**
 * Batches one pass may take (each up to about 10 minutes of collection, one
 * per cron run). A pass that needs more fails safely (nothing applied).
 */
export const MAX_BATCHES_PER_PASS = 24;
/** "Sync access now" starts a pass at most this often. */
const MANUAL_MIN_GAP_MS = HOUR_MS;

export interface M365PermsWorkerEnv extends M365PermsEnv, M365SyncEnv {
  DB: D1Database;
}

export interface M365PermsDeps {
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  newId?: () => string;
  budgets?: Partial<{ timeMs: number; d1: number; graph: number }>;
}

export type M365PermsTickResult =
  | { status: 'off' | 'busy' | 'not_installed' | 'not_configured' | 'idle' | 'backoff' | 'held' | 'collecting' }
  | { status: 'worked'; mode: M365PermsMode; finished: boolean }
  | { status: 'failed'; code: string };

const iso = (ms: number) => new Date(ms).toISOString();
const opKey = (op: DiffOp) => `${op.type}|${op.mailboxId}|${op.userId}`;
const age = (now: number, at: string | null | undefined) => (at ? now - Date.parse(at) : Number.POSITIVE_INFINITY);

class RoundFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RoundFailure';
  }
}

async function saveState(db: D1Database, state: M365PermsState): Promise<void> {
  await db.prepare(`UPDATE m365_perm_state SET state = ?, updated_at = datetime('now') WHERE id = 1`)
    .bind(JSON.stringify(state)).run();
}

function newRound(id: string, mode: M365PermsMode, now: number): M365PermsRound {
  return {
    id,
    mode,
    phase: 'collecting',
    startedAt: iso(now),
    groupsPending: [],
    groupsExpanded: [],
    groupsFailed: [],
    brake: null,
    removalsAllowed: true,
    removalKeys: [],
    counts: emptyM365PermsCounts(),
    report: [],
    heldItems: [],
    snapshot: null,
    batches: [{ runId: `${id}-b1`, startAfter: '' }],
    batchStartedAt: iso(now),
  };
}

type Expected = { tenantId: string; organization: string; now: number };

async function loadBatch(env: M365PermsWorkerEnv, runId: string, expected: Expected): Promise<PermissionSnapshot> {
  const result = await readCollect(env.M365_PERMS_COLLECTOR!, runId);
  if (result.status !== 'done') throw new RoundFailure(result.status === 'failed' ? result.code : 'snapshot_lost');
  const parsed = parseSnapshot(result.snapshot, expected);
  if (!parsed.ok) {
    console.warn('Mailbox access snapshot rejected', { reason: parsed.reason });
    throw new RoundFailure('bad_snapshot');
  }
  return parsed.snapshot;
}

/** The whole pass: every batch, read back, checked and joined. */
async function loadPass(env: M365PermsWorkerEnv, round: M365PermsRound, expected: Expected): Promise<PermissionSnapshot> {
  const batches = [];
  for (const batch of round.batches) batches.push({ startAfter: batch.startAfter, snapshot: await loadBatch(env, batch.runId, expected) });
  const merged = mergeBatches(batches);
  if (!merged) {
    console.warn('Mailbox access snapshot rejected', { reason: 'batches_do_not_fit' });
    throw new RoundFailure('bad_snapshot');
  }
  return merged;
}

async function discardRound(namespace: DurableObjectNamespace, round: M365PermsRound): Promise<void> {
  for (const batch of round.batches ?? []) await discardCollect(namespace, batch.runId).catch(() => undefined);
}

/** Group expansion uses the directory sync app (Graph). Null when it is not configured. */
function graphClient(env: M365PermsWorkerEnv, deps: M365PermsDeps): PermsGraphClient | null {
  const check = m365SyncConfig(env);
  if (!check.configured) return null;
  return new PermsGraphClient({
    tenantId: check.config.tenantId,
    clientId: check.config.clientId,
    clientSecret: check.config.clientSecret,
    fetcher: deps.fetcher,
    sleep: deps.sleep,
    now: deps.now,
  });
}

function finishRound(state: M365PermsState, round: M365PermsRound, now: number): void {
  state.lastRound = {
    id: round.id,
    mode: round.mode,
    startedAt: round.startedAt,
    finishedAt: iso(now),
    counts: round.counts,
    report: round.report,
    brake: round.brake,
    snapshot: round.snapshot,
  };
  state.lastFinishedAt = iso(now);
  state.round = null;
  state.lastError = null;
  state.consecutiveFailures = 0;
  state.backoffUntil = null;
}

export async function runM365PermsTick(env: M365PermsWorkerEnv, deps: M365PermsDeps = {}): Promise<M365PermsTickResult> {
  const db = env.DB;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const budgets = { timeMs: TICK_TIME_BUDGET_MS, d1: TICK_D1_BUDGET, graph: TICK_GRAPH_BUDGET, ...deps.budgets };

  // Off means off: one settings read, nothing else.
  const toggle = await loadM365PermsSwitch(db);
  if (!toggle.enabled) return { status: 'off' };

  const startedAt = now();
  try {
    await db.prepare(`INSERT OR IGNORE INTO m365_perm_state (id, state, lease_until) VALUES (1, '{}', 0)`).run();
  } catch {
    return { status: 'not_installed' };
  }
  const nowSeconds = Math.floor(startedAt / 1000);
  const lease = await db.prepare('UPDATE m365_perm_state SET lease_until = ? WHERE id = 1 AND lease_until < ?')
    .bind(nowSeconds + LEASE_SECONDS, nowSeconds).run();
  if (!lease.meta.changes) return { status: 'busy' };

  const row = await db.prepare('SELECT state FROM m365_perm_state WHERE id = 1').first<{ state: string }>();
  const state = parseM365PermsState(row?.state);
  state.lastTickAt = iso(startedAt);

  try {
    const check = m365PermsConfig(env);
    if (!check.configured) {
      state.lastResult = 'not_configured';
      state.lastError = { code: 'not_configured', at: iso(startedAt) };
      await saveState(db, state);
      return { status: 'not_configured' };
    }
    const config = check.config;
    const namespace = env.M365_PERMS_COLLECTOR!;
    const mode: M365PermsMode = toggle.dryRun ? 'dry_run' : 'live';
    const requested = Boolean(toggle.requestedAt) && toggle.requestedAt !== state.handledRequestAt;
    const expected = { tenantId: config.tenantId, organization: config.organization, now: startedAt };

    if (state.round) {
      const held = state.round.phase === 'held';
      const tooOld = age(startedAt, state.round.startedAt) > (held ? HELD_ROUND_MAX_AGE_MS : ROUND_MAX_AGE_MS);
      // A mode change, an old round or "Sync access now" on a held round starts afresh.
      if (state.round.mode !== mode || tooOld || (held && requested)) {
        await discardRound(namespace, state.round);
        await clearGroupMembers(db, null);
        state.round = null;
      }
    }
    if (state.round?.phase === 'held') {
      if (toggle.approvedRound !== state.round.id || state.round.brake?.reason === 'empty_snapshot') {
        state.lastResult = 'held';
        await saveState(db, state);
        return { status: 'held' };
      }
      // A manager approved this exact round: removals and downgrades may go ahead.
      state.round.removalsAllowed = true;
      state.round.phase = 'apply';
    }

    if (!state.round) {
      if (state.backoffUntil && Date.parse(state.backoffUntil) > startedAt && !requested) {
        await saveState(db, state);
        return { status: 'backoff' };
      }
      // A new pass at most every interval (6 to 24 hours), plus "Sync access
      // now" at most once an hour: at most 4 scheduled passes a day.
      const manual = requested && age(startedAt, state.lastStartedAt) >= MANUAL_MIN_GAP_MS;
      const due = manual || age(startedAt, state.lastStartedAt) >= config.intervalHours * HOUR_MS;
      if (due && requested) state.handledRequestAt = toggle.requestedAt;
      if (!due) {
        state.lastResult = state.consecutiveFailures ? 'error' : 'ok';
        await saveState(db, state);
        return { status: 'idle' };
      }
      const round = newRound(newId(), mode, startedAt);
      state.lastStartedAt = iso(startedAt);
      const started = await beginCollect(namespace, round.batches[0].runId, '').catch(() => null);
      if (started !== 'started') throw new RoundFailure(started === 'busy' ? 'collector_busy' : 'collector_failed');
      state.round = round;
      state.lastResult = 'collecting';
      await saveState(db, state);
      return { status: 'collecting' };
    }

    const round = state.round;
    const ctx: PermsApplyContext = { db, round, ops: 0, now };
    const withinBudget = () => now() - startedAt < budgets.timeMs && ctx.ops < budgets.d1;
    let finished = false;

    if (round.phase === 'collecting') {
      // One batch per cron run. Nothing is applied until the batch that
      // reaches the end of the mailbox list arrives; then the whole pass is
      // read back, joined and applied once.
      const batch = round.batches[round.batches.length - 1];
      const result = await readCollect(namespace, batch.runId);
      if (result.status === 'running') {
        if (age(startedAt, round.batchStartedAt) > COLLECT_TIMEOUT_MS) throw new RoundFailure('collector_timeout');
        state.lastResult = 'collecting';
        await saveState(db, state);
        return { status: 'collecting' };
      }
      if (result.status !== 'done') throw new RoundFailure(result.status === 'failed' ? result.code : 'collector_failed');
      const parsed = parseSnapshot(result.snapshot, expected);
      if (!parsed.ok) {
        console.warn('Mailbox access snapshot rejected', { reason: parsed.reason });
        throw new RoundFailure('bad_snapshot');
      }
      if (batch.startAfter && parsed.snapshot.mailboxes.some((mailbox) => mailbox.id <= batch.startAfter)) throw new RoundFailure('bad_snapshot');
      if (!parsed.snapshot.complete) {
        if (round.batches.length >= MAX_BATCHES_PER_PASS) throw new RoundFailure('pass_too_long');
        const next = { runId: `${round.id}-b${round.batches.length + 1}`, startAfter: parsed.snapshot.nextCursor || batch.startAfter };
        const started = await beginCollect(namespace, next.runId, next.startAfter).catch(() => null);
        if (started !== 'started') throw new RoundFailure(started === 'busy' ? 'collector_busy' : 'collector_failed');
        round.batches.push(next);
        round.batchStartedAt = iso(startedAt);
        state.lastResult = 'collecting';
        await saveState(db, state);
        return { status: 'collecting' };
      }
      const snapshot = await loadPass(env, round, expected);
      round.snapshot = {
        collectedAt: snapshot.collectedAt,
        mailboxes: snapshot.mailboxes.length,
        mailboxesInTenant: snapshot.mailboxCount,
        grants: snapshot.mailboxes.reduce((sum, mailbox) => sum + mailbox.grants.length, 0),
        complete: true,
        batches: round.batches.length,
        skipped: { ...snapshot.skipped },
      };
      round.groupsPending = groupTrustees(snapshot);
      round.phase = round.groupsPending.length ? 'groups' : 'diff';
      await clearGroupMembers(db, round.id);
      await saveState(db, state);
    }
    if (round.phase === 'groups') {
      const graph = graphClient(env, deps);
      while (round.groupsPending.length && withinBudget()) {
        const groupId = round.groupsPending[0];
        if (!graph) {
          // No directory app: these groups cannot be expanded, so the
          // mailboxes that grant them are treated as not covered.
          round.groupsFailed.push(...round.groupsPending);
          round.groupsPending = [];
          break;
        }
        if (graph.requests >= budgets.graph) break;
        try {
          const members = await graph.transitiveUserMembers(groupId, Math.max(1, budgets.graph - graph.requests));
          await saveGroupMembers(ctx, round.id, groupId, members);
          round.groupsExpanded.push(groupId);
        } catch (caught) {
          if (caught instanceof GraphError && caught.code === 'throttled') break;
          round.groupsFailed.push(groupId);
        }
        round.groupsPending = round.groupsPending.slice(1);
        await saveState(db, state);
      }
      if (round.groupsPending.length) {
        state.lastResult = 'running';
        await saveState(db, state);
        return { status: 'worked', mode: round.mode, finished: false };
      }
      round.phase = 'diff';
      await saveState(db, state);
    }

    // diff and apply both work from the stored snapshot, read again each tick.
    const snapshot = await loadPass(env, round, expected);
    const diffNow = async (includeManagers: boolean) => {
      const [sharedLinks, personLinks, assignments, ledger, groupMembers, released, managerLinks, unlinked] = await Promise.all([
        loadSharedLinks(ctx), loadPersonLinks(ctx), loadAssignments(ctx), loadLedger(ctx), loadGroupMembers(ctx, round.id), loadReleased(ctx),
        includeManagers && round.managerMatches ? loadManagerLinks(ctx, round.managerMatches) : Promise.resolve(new Map<string, PersonLink>()),
        loadUnlinkedLedgerAccounts(ctx),
      ]);
      // A linked person always wins over a manager match on the same object.
      for (const [objectId, link] of managerLinks) if (!personLinks.has(objectId)) personLinks.set(objectId, link);
      // An active manager not looked up this round (rotation, switch on) may
      // still be granted: not reported as kept-without-a-match.
      const lookedAt = new Set(round.managerLookedAt ?? []);
      for (const [userId, account] of unlinked) {
        if (includeManagers && account.activeManager && !lookedAt.has(userId)) unlinked.delete(userId);
      }
      return computeDiff({
        snapshot,
        sharedLinks,
        personLinks,
        groupMembers,
        expandedGroups: new Set(round.groupsExpanded ?? []),
        failedGroups: new Set(round.groupsFailed),
        released,
        assignments,
        ledger,
        fullAccessImpliesSend: config.fullAccessImpliesSend,
        unlinkedAccounts: unlinked,
      });
    };

    if (round.phase === 'diff') {
      if (toggle.includeManagers && !round.managerMatches) {
        // Read-only: Graph lookups by address and D1 reads. Saved on the round,
        // so apply (and a resumed tick) uses the same matches.
        const sync = m365SyncConfig(env);
        const graph = graphClient(env, deps);
        const matched = await resolveManagerMatches(ctx, graph, {
          mailDomain: sync.configured ? sync.config.mailDomain : '',
          graphBudget: budgets.graph,
          cursor: state.managerCursor ?? '',
          canContinue: withinBudget,
        });
        round.managerMatches = matched.matches;
        round.managerLookedAt = matched.lookedAt;
        state.managerCursor = matched.nextCursor;
        // Capped (MAX_MANAGER_REPORT_ROWS), so the diff's own rows keep their room.
        for (const item of matched.report.slice(0, MAX_MANAGER_REPORT_ROWS)) if (round.report.length < 200) round.report.push(item);
        console.info('Mailbox access sync: manager accounts matched by address', matched.outcomes);
      }
      const diff = await diffNow(toggle.includeManagers);
      // Counts that are not changes (manager-kept, not representable, ...) come from this one diff.
      for (const [countKey, value] of Object.entries(diff.counts)) {
        const k = countKey as keyof typeof round.counts;
        round.counts[k] = (round.counts[k] ?? 0) + value;
      }
      for (const item of diff.report) if (round.report.length < 200) round.report.push(item);
      round.brake = brakeCheck(diff, snapshot, config.maxRemovePercent);
      // The exact removals and downgrades decided now; apply (and an approval)
      // covers these and nothing else.
      const removals = diff.ops.filter((op) => op.type === 'remove' || op.type === 'downgrade');
      round.removalKeys = removals.slice(0, M365_PERMS_REMOVAL_LIMIT).map(opKey);
      round.heldItems = round.brake
        ? removals.slice(0, M365_PERMS_REPORT_LIMIT).map((op) => ({ action: op.type, mailbox: op.mailbox, user: op.user, reason: 'held_for_approval' }))
        : [];
      round.removalsAllowed = !round.brake;
      if (round.mode === 'dry_run') {
        // Report only: nothing is written but the status row.
        for (const op of diff.ops) reportOp(ctx, op);
        finishRound(state, round, now());
        await clearGroupMembers(db, null);
        await discardRound(namespace, round);
        state.lastResult = 'ok';
        await saveState(db, state);
        return { status: 'worked', mode: 'dry_run', finished: true };
      }
      round.phase = 'apply';
      if (round.brake) console.warn('Mailbox access sync: removals held by the brake', { reason: round.brake.reason, removals: round.brake.removals, owned: round.brake.ledger });
      await saveState(db, state);
    }

    if (round.phase === 'apply') {
      // Each op is tried at most once per run; one that did not land is
      // counted as changedConcurrently and looked at again by the next round.
      const attempted = new Set<string>();
      const allowedRemovals = new Set(round.removalKeys ?? []);
      for (;;) {
        // Switched off (or to dry run) since the tick began: stop before writing.
        const live = await loadM365PermsSwitch(db);
        ctx.ops += 1;
        if (!live.enabled || live.dryRun) {
          state.lastResult = 'running';
          await saveState(db, state);
          return { status: 'worked', mode: round.mode, finished: false };
        }
        const diff = await diffNow(live.includeManagers);
        const pending = diff.ops.filter((op: DiffOp) => {
          if (attempted.has(opKey(op))) return false;
          if (op.type === 'remove' || op.type === 'downgrade') return round.removalsAllowed && allowedRemovals.has(opKey(op));
          return true;
        });
        if (!pending.length) break;
        let progressed = false;
        for (const op of pending) {
          if (!withinBudget()) break;
          attempted.add(opKey(op));
          await applyOp(ctx, op);
          progressed = true;
        }
        await saveState(db, state);
        if (!withinBudget()) {
          state.lastResult = 'running';
          await saveState(db, state);
          return { status: 'worked', mode: round.mode, finished: false };
        }
        if (!progressed) break;
      }
      if (round.brake && !round.removalsAllowed) {
        round.phase = 'held';
        state.lastResult = 'held';
        await saveState(db, state);
        return { status: 'held' };
      }
      finishRound(state, round, now());
      finished = true;
      await clearGroupMembers(db, null);
      // Manager-removed marks for mailboxes or accounts that no longer exist.
      await db.prepare(
        `DELETE FROM m365_perm_released
         WHERE NOT EXISTS (SELECT 1 FROM mailboxes m WHERE m.id = m365_perm_released.mailbox_id)
            OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m365_perm_released.user_id)`,
      ).run();
      await discardRound(namespace, round);
    }

    state.lastResult = 'ok';
    await saveState(db, state);
    return { status: 'worked', mode, finished };
  } catch (caught) {
    const at = now();
    const code = caught instanceof RoundFailure ? caught.code
      : caught instanceof GraphError ? `graph_${caught.code}`
        : 'internal';
    // Nothing is changed on failure: the round is dropped and current
    // assignments stay exactly as they are. Next attempt after a back-off.
    if (state.round) await discardRound(env.M365_PERMS_COLLECTOR!, state.round);
    await clearGroupMembers(db, null).catch(() => undefined);
    state.round = null;
    state.consecutiveFailures += 1;
    const wait = Math.min(MAX_BACKOFF_MS, HOUR_MS * 2 ** Math.min(state.consecutiveFailures - 1, 5));
    state.backoffUntil = iso(at + wait);
    state.lastResult = 'error';
    state.lastError = { code: code.slice(0, 48), at: iso(at) };
    console.error('Mailbox access sync failed', {
      code,
      failures: state.consecutiveFailures,
      alert: state.consecutiveFailures >= M365_PERMS_FAILURE_ALERT,
      error: caught instanceof Error ? caught.name : 'UnknownError',
    });
    try {
      await saveState(db, state);
    } catch {
      // The lease below still expires on its own.
    }
    return { status: 'failed', code };
  } finally {
    await db.prepare('UPDATE m365_perm_state SET lease_until = 0 WHERE id = 1').run().catch(() => undefined);
  }
}

/** Read-only check for Admin over the private service binding: setting names only. */
export function m365PermsConfigDiagnostic(env: M365PermsWorkerEnv): { configured: boolean; problems: string[]; groups: boolean } {
  const check = m365PermsConfig(env);
  const groups = m365SyncConfig(env).configured;
  return check.configured ? { configured: true, problems: [], groups } : { configured: false, problems: check.problems, groups };
}
