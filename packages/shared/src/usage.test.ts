import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mailRejectCode, recordUsage, statusClass, type UsageDataset } from './usage.ts';

function fake() {
  const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
  const dataset: UsageDataset = { writeDataPoint: (p) => { points.push(p); } };
  return { points, dataset };
}

describe('recordUsage', () => {
  it('writes only fixed words and three numbers', () => {
    const { points, dataset } = fake();
    recordUsage({ USAGE: dataset }, { name: '/mail/[id]', outcome: 'ok', status: 200, ms: 12.5, bytes: 0, count: 0 });
    assert.deepEqual(points, [{ indexes: ['/mail/[id]'], blobs: ['/mail/[id]', 'ok', '2xx'], doubles: [12.5, 0, 0] }]);
  });

  it('does nothing without a binding', () => {
    assert.doesNotThrow(() => recordUsage(undefined, { name: 'x', outcome: 'ok', status: 200 }));
    assert.doesNotThrow(() => recordUsage({}, { name: 'x', outcome: 'ok', status: 200 }));
  });

  it('never throws when the dataset throws', () => {
    const dataset: UsageDataset = { writeDataPoint: () => { throw new Error('boom'); } };
    assert.doesNotThrow(() => recordUsage({ USAGE: dataset }, { name: 'x', outcome: 'ok', status: 200 }));
  });

  it('replaces a free-text or over-long name with other', () => {
    const { points, dataset } = fake();
    recordUsage({ USAGE: dataset }, { name: 'a'.repeat(300), outcome: '', status: NaN });
    recordUsage({ USAGE: dataset }, { name: 'bob@example.test says hi', outcome: 'ok', status: 200 });
    assert.equal(points[1].blobs?.[0], 'other');
    assert.equal(points[0].blobs?.[0], 'other');
    assert.deepEqual(points[0].blobs?.slice(1), ['ok', '0xx']);
    assert.deepEqual(points[0].doubles, [0, 0, 0]);
  });
});

describe('statusClass', () => {
  it('reduces a status to its class', () => {
    assert.equal(statusClass(204), '2xx');
    assert.equal(statusClass(503), '5xx');
    assert.equal(statusClass(0), '0xx');
  });
});

describe('mailRejectCode', () => {
  it('maps our fixed reject texts to fixed codes', () => {
    assert.equal(mailRejectCode('Message exceeds the configured size limit'), 'size_limit');
    assert.equal(mailRejectCode('Stanchion: recipient unavailable; verify the address or contact the organisation'), 'unknown_recipient');
    assert.equal(mailRejectCode('Attachment type not allowed'), 'attachment_type');
  });

  it('journal refusals have their own code', () => {
    assert.equal(mailRejectCode('Stanchion: journal report refused'), 'journal_refused');
  });

  it('does not match by prefix except for the recipient text', () => {
    assert.equal(mailRejectCode('Attachment type not allowed: bob@example.test'), 'rejected_other');
  });

  it('turns anything unknown into rejected_other and never echoes it', () => {
    assert.equal(mailRejectCode('550 bob@example.test mailbox full'), 'rejected_other');
    assert.equal(mailRejectCode(undefined), 'rejected_other');
  });
});
