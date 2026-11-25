import { describe, expect, it, vi } from 'vitest';

import {
  applyCalendarWrites,
  extractCalendarText,
  isCalendarAttachment,
  planCalendarWrites,
  type ExistingCalendarEvent,
} from './calendar';
import type { ParsedEvent } from '@stanchion/shared/ics';

function baseEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    uid: 'event-1@example.test',
    sequence: 0,
    summary: 'Quarterly review',
    description: '',
    location: '',
    startsAtUtc: '2026-09-01T09:00:00Z',
    endsAtUtc: '2026-09-01T10:00:00Z',
    allDay: false,
    status: 'confirmed',
    organizerAddress: 'organizer@example.test',
    organizerName: 'Organizer Example',
    attendees: [{ address: 'alice@example.test', name: 'Alice Example', partstat: 'accepted' }],
    rrule: null,
    ...overrides,
  };
}

const ORGANIZER_TRUST = { authenticated: true, senderAddress: 'organizer@example.test' } as const;
const ATTENDEE_TRUST = { authenticated: true, senderAddress: 'alice@example.test' } as const;

// ─── planCalendarWrites (pure decision logic) ──────────────────────────────

describe('planCalendarWrites', () => {
  it('inserts a new event on REQUEST when no row exists for the UID', () => {
    const event = baseEvent();
    expect(planCalendarWrites('REQUEST', event, null)).toEqual({ kind: 'insert', event });
  });

  it('inserts a new event on PUBLISH the same as REQUEST', () => {
    const event = baseEvent();
    expect(planCalendarWrites('PUBLISH', event, null)).toEqual({ kind: 'insert', event });
  });

  it('updates an existing event on REQUEST when the sequence has caught up or advanced', () => {
    const existing: ExistingCalendarEvent = { id: 'row-1', sequence: 2 };
    expect(planCalendarWrites('REQUEST', baseEvent({ sequence: 2 }), existing))
      .toEqual({ kind: 'update', eventId: 'row-1', event: baseEvent({ sequence: 2 }) });
    expect(planCalendarWrites('REQUEST', baseEvent({ sequence: 5 }), existing))
      .toEqual({ kind: 'update', eventId: 'row-1', event: baseEvent({ sequence: 5 }) });
  });

  it('skips a REQUEST whose sequence is older than the stored row', () => {
    const existing: ExistingCalendarEvent = { id: 'row-1', sequence: 5 };
    expect(planCalendarWrites('REQUEST', baseEvent({ sequence: 3 }), existing))
      .toEqual({ kind: 'skip', reason: 'stale-sequence' });
  });

  it('cancels an existing event on CANCEL when the sequence has caught up', () => {
    const existing: ExistingCalendarEvent = { id: 'row-1', sequence: 1 };
    expect(planCalendarWrites('CANCEL', baseEvent({ sequence: 2 }), existing))
      .toEqual({ kind: 'cancel', eventId: 'row-1', sequence: 2 });
  });

  it('skips a CANCEL for an event that was never seen', () => {
    expect(planCalendarWrites('CANCEL', baseEvent(), null)).toEqual({ kind: 'skip', reason: 'not-found' });
  });

  it('skips a CANCEL whose sequence is older than the stored row', () => {
    const existing: ExistingCalendarEvent = { id: 'row-1', sequence: 5 };
    expect(planCalendarWrites('CANCEL', baseEvent({ sequence: 1 }), existing))
      .toEqual({ kind: 'skip', reason: 'stale-sequence' });
  });

  it('updates only the responding attendee on REPLY for an existing event', () => {
    const existing: ExistingCalendarEvent = { id: 'row-1', sequence: 0 };
    const event = baseEvent({
      attendees: [{ address: 'Alice@Example.test', name: 'Alice Example', partstat: 'declined' }],
    });
    expect(planCalendarWrites('REPLY', event, existing)).toEqual({
      kind: 'update-attendee',
      eventId: 'row-1',
      address: 'alice@example.test',
      partstat: 'declined',
    });
  });

  it('skips a REPLY for an event the organizer copy never recorded', () => {
    expect(planCalendarWrites('REPLY', baseEvent(), null)).toEqual({ kind: 'skip', reason: 'not-found' });
  });

  it('skips a REPLY with no attendee entry to attribute the response to', () => {
    const existing: ExistingCalendarEvent = { id: 'row-1', sequence: 0 };
    expect(planCalendarWrites('REPLY', baseEvent({ attendees: [] }), existing))
      .toEqual({ kind: 'skip', reason: 'no-attendee' });
  });

  it('skips an event with no UID regardless of method', () => {
    for (const method of ['REQUEST', 'REPLY', 'CANCEL', 'PUBLISH', null] as const) {
      expect(planCalendarWrites(method, baseEvent({ uid: '' }), null)).toEqual({ kind: 'skip', reason: 'no-uid' });
    }
  });

  it('skips an unrecognised or absent METHOD', () => {
    expect(planCalendarWrites(null, baseEvent(), null)).toEqual({ kind: 'skip', reason: 'unsupported-method' });
  });
});

// ─── detection helpers ──────────────────────────────────────────────────────

describe('isCalendarAttachment', () => {
  it('recognises text/calendar and application/ics content types case-insensitively', () => {
    expect(isCalendarAttachment({ mimeType: 'text/calendar' })).toBe(true);
    expect(isCalendarAttachment({ mimeType: 'TEXT/CALENDAR' })).toBe(true);
    expect(isCalendarAttachment({ mimeType: 'application/ics' })).toBe(true);
    expect(isCalendarAttachment({ mimeType: 'text/calendar; method=REQUEST' })).toBe(true);
  });

  it('recognises a PostalMime-detected method even without a calendar content type', () => {
    expect(isCalendarAttachment({ mimeType: 'application/octet-stream', method: 'REQUEST' })).toBe(true);
  });

  it('rejects ordinary attachments', () => {
    expect(isCalendarAttachment({ mimeType: 'image/png' })).toBe(false);
    expect(isCalendarAttachment({ mimeType: 'application/pdf' })).toBe(false);
    expect(isCalendarAttachment({})).toBe(false);
  });
});

describe('extractCalendarText', () => {
  it('returns string content unchanged', () => {
    expect(extractCalendarText({ mimeType: 'text/calendar', content: 'BEGIN:VCALENDAR' })).toBe('BEGIN:VCALENDAR');
  });

  it('decodes Uint8Array and ArrayBuffer content as UTF-8', () => {
    const bytes = new TextEncoder().encode('BEGIN:VCALENDARé');
    expect(extractCalendarText({ mimeType: 'text/calendar', content: bytes })).toBe('BEGIN:VCALENDARé');
    expect(extractCalendarText({ mimeType: 'text/calendar', content: bytes.buffer })).toBe('BEGIN:VCALENDARé');
  });

  it('returns null for a non-calendar attachment without decoding it', () => {
    expect(extractCalendarText({ mimeType: 'image/png', content: 'not calendar text' })).toBe(null);
  });
});

// ─── applyCalendarWrites (D1 orchestration) ────────────────────────────────

interface RecordedStatement { query: string; values: unknown[] }

function fakeCalendarDb(options: {
  existing?: Record<string, { id: string; sequence: number; organizer_address?: string }>;
  failFirst?: boolean;
  failBatch?: boolean;
} = {}) {
  const batches: RecordedStatement[][] = [];
  const batch = vi.fn(async (statements: RecordedStatement[]) => {
    if (options.failBatch) throw new Error('D1 batch unavailable');
    batches.push(statements);
    return statements.map(() => ({ success: true }));
  });

  const database = {
    prepare(query: string) {
      return {
        bind: (...values: unknown[]): RecordedStatement & { first: <T>() => Promise<T | null> } => ({
          query,
          values,
          first: async <T,>(): Promise<T | null> => {
            if (options.failFirst) throw new Error('D1 unavailable');
            if (!query.includes('FROM calendar_events')) return null;
            const [mailboxId, uid] = values as [string, string];
            const row = options.existing?.[`${mailboxId}\u0000${uid}`];
            return (row ? { ...row, organizer_address: row.organizer_address ?? 'organizer@example.test' } : null) as unknown as T | null;
          },
        }),
      };
    },
    batch,
  };
  return { database, batches, batch };
}

function findStatement(statements: RecordedStatement[], predicate: (query: string) => boolean): RecordedStatement | undefined {
  return statements.find((statement) => predicate(statement.query));
}

const REQUEST_ICS = [
  'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:invite-1@example.test',
  'SEQUENCE:0',
  'DTSTART:20260901T090000Z',
  'DTEND:20260901T100000Z',
  'SUMMARY:Quarterly review',
  'ORGANIZER;CN=Organizer Example:mailto:Organizer@Example.test',
  'ATTENDEE;CN=Alice Example;PARTSTAT=ACCEPTED:mailto:Alice@Example.test',
  'ATTENDEE;CN=Alice Duplicate;PARTSTAT=ACCEPTED:mailto:ALICE@example.test',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

describe('applyCalendarWrites — REQUEST', () => {
  it('inserts a new calendar_events row and deduplicated, lowercased attendee rows', async () => {
    const { database, batches } = fakeCalendarDb();
    await applyCalendarWrites(database as unknown as D1Database, 'mailbox-1', 'message-1', [REQUEST_ICS], ORGANIZER_TRUST);

    expect(batches).toHaveLength(1);
    const statements = batches[0]!;
    const insertEvent = findStatement(statements, (q) => q.includes('INSERT INTO calendar_events'));
    expect(insertEvent).toBeDefined();
    expect(insertEvent!.values).toEqual([
      expect.any(String), 'mailbox-1', 'invite-1@example.test', 0,
      'Quarterly review', '', '', '2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', 0, 'confirmed',
      'organizer@example.test', 'message-1', null,
    ]);

    const attendeeInserts = statements.filter((statement) => statement.query.includes('INSERT INTO calendar_attendees'));
    // The two ATTENDEE lines differ only by case and must collapse to one row.
    expect(attendeeInserts).toHaveLength(1);
    expect(attendeeInserts[0]!.values).toEqual([
      expect.any(String), insertEvent!.values[0], 'alice@example.test', 'Alice Example', 'accepted',
    ]);
  });

  it('updates an existing row and fully replaces its attendees when the sequence has caught up', async () => {
    const { database, batches } = fakeCalendarDb({
      existing: { 'mailbox-1\u0000invite-1@example.test': { id: 'existing-row', sequence: 0 } },
    });
    await applyCalendarWrites(database as unknown as D1Database, 'mailbox-1', 'message-2', [REQUEST_ICS], ORGANIZER_TRUST);

    expect(batches).toHaveLength(1);
    const statements = batches[0]!;
    const update = findStatement(statements, (q) => q.startsWith('UPDATE calendar_events'));
    expect(update!.values).toContain('existing-row');
    expect(update!.values).toContain('message-2');

    const del = findStatement(statements, (q) => q.startsWith('DELETE FROM calendar_attendees'));
    expect(del!.values).toEqual(['existing-row']);

    const insertIndex = statements.findIndex((statement) => statement.query.startsWith('INSERT INTO calendar_attendees'));
    const deleteIndex = statements.findIndex((statement) => statement.query.startsWith('DELETE FROM calendar_attendees'));
    expect(deleteIndex).toBeLessThan(insertIndex);
  });

  it('does not touch D1 when the incoming sequence is older than the stored row', async () => {
    const staleIcs = REQUEST_ICS.replace('SEQUENCE:0', 'SEQUENCE:1');
    const { database, batch } = fakeCalendarDb({
      existing: { 'mailbox-1\u0000invite-1@example.test': { id: 'existing-row', sequence: 5 } },
    });
    await applyCalendarWrites(database as unknown as D1Database, 'mailbox-1', 'message-3', [staleIcs], ORGANIZER_TRUST);
    expect(batch).not.toHaveBeenCalled();
  });
});

const CANCEL_ICS = [
  'BEGIN:VCALENDAR', 'METHOD:CANCEL', 'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:invite-1@example.test',
  'SEQUENCE:1',
  'DTSTART:20260901T090000Z',
  'STATUS:CANCELLED',
  'ORGANIZER:mailto:organizer@example.test',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

describe('applyCalendarWrites — CANCEL', () => {
  it('marks an existing event cancelled and advances its sequence', async () => {
    const { database, batches } = fakeCalendarDb({
      existing: { 'mailbox-1\u0000invite-1@example.test': { id: 'existing-row', sequence: 0 } },
    });
    await applyCalendarWrites(database as unknown as D1Database, 'mailbox-1', 'message-cancel', [CANCEL_ICS], ORGANIZER_TRUST);

    expect(batches).toHaveLength(1);
    const statements = batches[0]!;
    expect(statements).toHaveLength(1);
    expect(statements[0]!.query).toContain("SET status = 'cancelled'");
    expect(statements[0]!.values).toEqual([1, 'message-cancel', 'existing-row']);
  });

  it('does nothing for a CANCEL of an event that was never recorded', async () => {
    const { database, batch } = fakeCalendarDb();
    await applyCalendarWrites(database as unknown as D1Database, 'mailbox-1', 'message-cancel', [CANCEL_ICS], ORGANIZER_TRUST);
    expect(batch).not.toHaveBeenCalled();
  });
});

const REPLY_ICS = [
  'BEGIN:VCALENDAR', 'METHOD:REPLY', 'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:invite-1@example.test',
  'SEQUENCE:0',
  'DTSTART:20260901T090000Z',
  'ORGANIZER:mailto:organizer@example.test',
  'ATTENDEE;PARTSTAT=DECLINED:mailto:Alice@Example.test',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

describe('applyCalendarWrites — REPLY', () => {
  it('updates only the matching attendee row, using a lowercased address', async () => {
    const { database, batches } = fakeCalendarDb({
      existing: { 'mailbox-1\u0000invite-1@example.test': { id: 'existing-row', sequence: 0 } },
    });
    await applyCalendarWrites(database as unknown as D1Database, 'mailbox-1', 'message-reply', [REPLY_ICS], ATTENDEE_TRUST);

    expect(batches).toHaveLength(1);
    const statements = batches[0]!;
    expect(statements).toHaveLength(1);
    expect(statements[0]!.query).toContain('UPDATE calendar_attendees');
    expect(statements[0]!.query).toContain('WHERE event_id = ? AND address = ?');
    expect(statements[0]!.values).toEqual(['declined', 'existing-row', 'alice@example.test']);
  });

  it('does nothing for a REPLY to an event the organizer copy never recorded', async () => {
    const { database, batch } = fakeCalendarDb();
    await applyCalendarWrites(database as unknown as D1Database, 'mailbox-1', 'message-reply', [REPLY_ICS], ATTENDEE_TRUST);
    expect(batch).not.toHaveBeenCalled();
  });
});

describe('applyCalendarWrites — never blocks or throws for mail delivery', () => {
  it('does not mutate calendar state without trusted authentication', async () => {
    const { database, batch } = fakeCalendarDb();
    await applyCalendarWrites(database as unknown as D1Database, 'mailbox-1', 'message-1', [REQUEST_ICS], {
      authenticated: false,
      senderAddress: 'organizer@example.test',
    });
    expect(batch).not.toHaveBeenCalled();
  });

  it('does not let an authenticated attacker hijack an existing event with a higher sequence', async () => {
    const hijackIcs = REQUEST_ICS.replace('SEQUENCE:0', 'SEQUENCE:6')
      .replace('mailto:Organizer@Example.test', 'mailto:attacker@example.test');
    const { database, batch } = fakeCalendarDb({
      existing: {
        'mailbox-1\u0000invite-1@example.test': {
          id: 'existing-row',
          sequence: 0,
          organizer_address: 'organizer@example.test',
        },
      },
    });
    await applyCalendarWrites(database as unknown as D1Database, 'mailbox-1', 'message-1', [hijackIcs], {
      authenticated: true,
      senderAddress: 'attacker@example.test',
    });
    expect(batch).not.toHaveBeenCalled();
  });

  it('resolves without throwing when the existing-row lookup fails', async () => {
    const { database } = fakeCalendarDb({ failFirst: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(applyCalendarWrites(database as unknown as D1Database, 'mailbox-1', 'message-1', [REQUEST_ICS], ORGANIZER_TRUST))
        .resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('resolves without throwing when the batch write fails', async () => {
    const { database } = fakeCalendarDb({ failBatch: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(applyCalendarWrites(database as unknown as D1Database, 'mailbox-1', 'message-1', [REQUEST_ICS], ORGANIZER_TRUST))
        .resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('resolves without throwing for unparseable or non-calendar text, without touching D1', async () => {
    const { database, batch } = fakeCalendarDb();
    await expect(applyCalendarWrites(database as unknown as D1Database, 'mailbox-1', 'message-1', ['not an ics document'], ORGANIZER_TRUST))
      .resolves.toBeUndefined();
    expect(batch).not.toHaveBeenCalled();
  });

  it('processes multiple calendar parts independently, one D1 batch per event', async () => {
    const secondIcs = REQUEST_ICS
      .replace('invite-1@example.test', 'invite-2@example.test')
      .replace('SUMMARY:Quarterly review', 'SUMMARY:Second meeting');
    const { database, batches } = fakeCalendarDb();
    await applyCalendarWrites(database as unknown as D1Database, 'mailbox-1', 'message-1', [REQUEST_ICS, secondIcs], ORGANIZER_TRUST);
    expect(batches).toHaveLength(2);
  });
});
