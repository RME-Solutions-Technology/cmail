import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  D1_BYTES_PER_MESSAGE,
  D1_MAX_DATABASE_BYTES,
  GRAPH_IMPORT_MESSAGES_PER_RUN,
  GRAPH_IMPORT_PERIODS,
  formatBytes,
  formatDuration,
  formatUsd,
  graphImportCountChanged,
  graphImportFigures,
  graphImportPeriodAt,
  graphImportProgress,
  graphImportSinceMs,
  parseGraphImportEstimate,
  parseGraphImportJob,
  parseGraphImportRequest,
} from './graph-import.ts';

const NOW = Date.parse('2026-11-17T00:00:00Z');
const DAY = 86_400_000;

describe('Import older mail: the slider', () => {
  it('has the eight stops in order, ending with All', () => {
    assert.deepEqual(GRAPH_IMPORT_PERIODS.map((period) => period.label), ['1 week', '1 month', '2 months', '3 months', '6 months', '12 months', '2 years', 'All mail']);
    assert.equal(graphImportPeriodAt('0')?.key, '1w');
    assert.equal(graphImportPeriodAt('7')?.key, 'all');
    for (const bad of ['8', '-1', '1.5', 'x', '', null, undefined, 3.5]) assert.equal(graphImportPeriodAt(bad), null, String(bad));
  });

  it('turns a period into a floor; All has none', () => {
    assert.equal(graphImportSinceMs('1w', NOW), NOW - 7 * DAY);
    assert.equal(graphImportSinceMs('2y', NOW), NOW - 730 * DAY);
    assert.equal(graphImportSinceMs('all', NOW), 0);
  });
});

describe('Import older mail: cost, storage and time maths', () => {
  it('adds D1 rows, R2 bytes, a monthly price and a time from the per-run limit', () => {
    const figures = graphImportFigures({ messages: 100_000, bytes: 30_000_000_000, d1UsedBytes: 1_000_000_000, period: '12m' });
    assert.equal(figures.d1AddBytes, 100_000 * D1_BYTES_PER_MESSAGE);
    assert.equal(figures.d1AfterBytes, 1_000_000_000 + 300_000_000);
    assert.equal(figures.d1Level, 'ok');
    assert.equal(figures.d1AfterPercent, 13);
    assert.equal(figures.r2AddBytes, 30_000_000_000);
    // 30 GB at $0.015 per GB-month; 20 GB above the 10 GB free tier.
    assert.ok(Math.abs(figures.r2UsdPerMonth - 0.45) < 1e-9);
    assert.ok(Math.abs(figures.r2UsdPerMonthAfterFree - 0.3) < 1e-9);
    // 100,000 messages at 250 a run, one run every 5 minutes: 400 runs = 2,000 minutes.
    assert.equal(figures.runs, Math.ceil(100_000 / GRAPH_IMPORT_MESSAGES_PER_RUN));
    assert.equal(figures.runs, 400);
    assert.ok(Math.abs(figures.hours - 2000 / 60) < 1e-9);
    assert.equal(figures.blocked, false);
  });

  it('warns near the limit and blocks over it, for any period', () => {
    const near = graphImportFigures({ messages: 1_000_000, bytes: 1, d1UsedBytes: 5_500_000_000, period: '6m' });
    assert.equal(near.d1Level, 'near');
    assert.equal(near.blocked, false);
    const over = graphImportFigures({ messages: 2_000_000, bytes: 1, d1UsedBytes: 5_000_000_000, period: 'all' });
    assert.equal(over.d1AfterBytes, 11_000_000_000);
    assert.ok((over.d1AfterBytes ?? 0) > D1_MAX_DATABASE_BYTES);
    assert.deepEqual([over.d1Level, over.blocked, over.blockReason], ['over', true, 'd1_over']);
    const shortOver = graphImportFigures({ messages: 4_000_000, bytes: 1, d1UsedBytes: 0, period: '1m' });
    assert.equal(shortOver.blocked, true);
  });

  it('cannot check an unknown database size: blocks All only', () => {
    assert.equal(graphImportFigures({ messages: 10, bytes: 1, d1UsedBytes: null, period: 'all' }).blockReason, 'd1_unknown');
    const month = graphImportFigures({ messages: 10, bytes: 1, d1UsedBytes: null, period: '1m' });
    assert.deepEqual([month.d1Level, month.blocked], ['unknown', false]);
  });

  it('an empty period needs no runs and costs nothing', () => {
    const figures = graphImportFigures({ messages: 0, bytes: 0, d1UsedBytes: 100, period: '1w' });
    assert.deepEqual([figures.runs, figures.hours, figures.r2UsdPerMonth, figures.blocked], [0, 0, 0, false]);
  });

  it('formats in plain words', () => {
    assert.equal(formatBytes(1_500_000_000), '1.5 GB');
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatDuration(0), 'under 5 minutes');
    assert.equal(formatDuration(0.5), 'about 30 minutes');
    assert.equal(formatDuration(3), 'about 3 hours');
    assert.equal(formatDuration(100), 'about 4 days');
    assert.equal(formatUsd(0), '$0');
    assert.equal(formatUsd(0.3), '$0.30');
  });
});

describe('Import older mail: re-check and progress', () => {
  it('asks again when the recount moves by more than 20%', () => {
    assert.equal(graphImportCountChanged(1000, 1200), false);
    assert.equal(graphImportCountChanged(1000, 1201), true);
    assert.equal(graphImportCountChanged(1000, 799), true);
    assert.equal(graphImportCountChanged(0, 0), false);
    assert.equal(graphImportCountChanged(0, 5), true);
  });

  it('shows remaining and time left from the confirmed count', () => {
    const job = parseGraphImportJob(JSON.stringify({ id: 'j1', period: '1m', status: 'running', estMessages: 1000, processed: 250 }));
    assert.ok(job);
    assert.deepEqual(graphImportProgress(job), { percent: 25, remaining: 750, etaHours: 15 / 60 });
  });
});

describe('Import older mail: stored records are parsed defensively', () => {
  it('rejects anything malformed', () => {
    assert.equal(parseGraphImportRequest('not json'), null);
    assert.equal(parseGraphImportRequest(JSON.stringify({ seq: 'a', kind: 'drop', period: '1m' })), null);
    assert.equal(parseGraphImportRequest(JSON.stringify({ seq: 'a b', kind: 'estimate', period: '1m' })), null);
    assert.equal(parseGraphImportRequest(JSON.stringify({ seq: 'a', kind: 'estimate', period: '5y' })), null);
    assert.deepEqual(parseGraphImportRequest(JSON.stringify({ seq: 'a', kind: 'start', period: '3m', at: 5, confirm: { messages: 4, bytes: 9 } })),
      { seq: 'a', kind: 'start', period: '3m', at: 5, confirm: { messages: 4, bytes: 9 } });
    assert.equal(parseGraphImportEstimate(JSON.stringify({ id: 'e', period: '1m', status: 'weird' })), null);
    assert.equal(parseGraphImportJob(JSON.stringify({ id: 'j', period: '1m', status: 'running', filed: -3, error: '<script>' }))?.filed, 0);
    assert.equal(parseGraphImportJob(JSON.stringify({ id: 'j', period: '1m', status: 'running', error: '<script>' }))?.error, '');
  });
});
