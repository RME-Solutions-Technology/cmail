// Reads the standby probe's traffic light (docs/standby-probe.md) straight
// from the instance's D1 database, read-only, through the Cloudflare D1
// query API. The colour rules mirror standbyStatusView() in
// packages/shared/src/standby.ts; keep the two in step.

export const PROBE_SETTING_ENABLED = 'standby_enabled';
export const AMBER_WARNINGS = new Set(['spam_folder', 'dmarc_not_pass', 'slow']);
export const STALE_AMBER_MS = 26 * 60 * 60 * 1000;
export const STALE_RED_MS = 50 * 60 * 60 * 1000;
export const DEFAULT_PROBE_TIMEOUT_MINUTES = 10;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {{ enabled: boolean, runs: Array<{status: string, reason?: string, warnings?: string, started_at: number, received_at?: number|null}>, now: number, timeoutMinutes: number }} input
 * @returns {{ light: 'off'|'green'|'amber'|'red', reason: string, lastPassAt: number|null }}
 */
export function probeLight({ enabled, runs, now, timeoutMinutes }) {
  const sorted = [...runs]
    .map((run) => ({
      status: String(run.status),
      reason: String(run.reason ?? ''),
      warnings: String(run.warnings ?? '').split(',').map((w) => w.trim()).filter(Boolean),
      startedAt: Number(run.started_at),
      receivedAt: run.received_at === null || run.received_at === undefined ? null : Number(run.received_at),
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const inFlight = sorted.find((run) => run.status === 'sending' || run.status === 'waiting') ?? null;
  const overdue = inFlight && now - inFlight.startedAt > timeoutMs ? inFlight : null;
  const last = sorted.find((run) => run.status === 'pass' || run.status === 'fail') ?? null;
  const lastPassAt = last?.status === 'pass' ? (last.receivedAt ?? last.startedAt) : null;
  if (!enabled) return { light: 'off', reason: 'standby address switched off', lastPassAt };
  if (overdue && (!last || overdue.startedAt > last.startedAt)) return { light: 'red', reason: 'timeout', lastPassAt };
  if (!last) return { light: 'amber', reason: inFlight ? 'running' : 'never', lastPassAt };
  if (last.status === 'fail') return { light: 'red', reason: last.reason || 'timeout', lastPassAt };
  const age = now - (last.receivedAt ?? last.startedAt);
  if (age > STALE_RED_MS) return { light: 'red', reason: 'stale', lastPassAt };
  if (age > STALE_AMBER_MS) return { light: 'amber', reason: 'stale', lastPassAt };
  const warning = last.warnings.find((w) => AMBER_WARNINGS.has(w));
  if (warning) return { light: 'amber', reason: warning, lastPassAt };
  return { light: 'green', reason: '', lastPassAt };
}

/**
 * Reads the switch and the last week of probe runs. Two SELECTs, nothing
 * written. Throws (CloudflareError) when D1 cannot be read, for example when
 * the probe's tables (migration 0023) do not exist on this instance.
 */
export async function readProbe(client, { accountId, databaseId, now, timeoutMinutes }) {
  const since = Math.max(0, Math.floor(now - LOOKBACK_MS));
  const results = await client.d1Query(accountId, databaseId, [
    `SELECT value FROM org_settings WHERE key = '${PROBE_SETTING_ENABLED}'`,
    `SELECT status, reason, warnings, started_at, received_at FROM standby_probe_runs WHERE started_at >= ${since} ORDER BY started_at DESC LIMIT 200`,
  ]);
  if (results.length !== 2 || results.some((r) => r?.success !== true || !Array.isArray(r.results))) {
    throw new Error('D1 returned an unexpected answer for the probe query.');
  }
  const enabled = results[0].results[0]?.value === 'true';
  return probeLight({ enabled, runs: results[1].results, now, timeoutMinutes });
}
