import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FOCUS_REASONS,
  FOCUS_REASON_TEXT,
  FREQUENT_SENDER_THRESHOLD,
  classifyFocus,
  focusDomainCandidates,
  focusHeaderSignals,
  focusScansNeeded,
  isAutomatedSender,
  isFocusClass,
  isFocusReason,
  normalizeFocusAddress,
  normalizeFocusDomain,
  senderDomain,
  type FocusFacts,
} from './focused-inbox.ts';

// Invented example.test / example.org addresses only.
const NONE = { deliveryReport: false, autoSubmitted: false, mailingList: false, bulkPrecedence: false };
const base: FocusFacts = {
  sender: 'pat@partner.example.org',
  mailDomain: 'example.test',
  signals: NONE,
  senderAuthenticated: true,
  addressOverride: null,
  domainOverride: null,
  correspondent: false,
  sharedMailbox: false,
  recentFromSender: 0,
};
const classify = (patch: Partial<FocusFacts>) => classifyFocus({ ...base, ...patch });

describe('focusHeaderSignals', () => {
  it('returns null when there are no headers to read', () => {
    assert.equal(focusHeaderSignals(null), null);
    assert.equal(focusHeaderSignals(undefined), null);
  });

  it('reads Auto-Submitted, but not "no"', () => {
    assert.equal(focusHeaderSignals([{ key: 'auto-submitted', value: 'auto-replied' }])?.autoSubmitted, true);
    assert.equal(focusHeaderSignals([{ key: 'Auto-Submitted', value: 'auto-generated; owner-email="a@example.test"' }])?.autoSubmitted, true);
    assert.equal(focusHeaderSignals([{ key: 'auto-submitted', value: 'No' }])?.autoSubmitted, false);
    assert.equal(focusHeaderSignals([{ key: 'auto-submitted', value: ' ' }])?.autoSubmitted, false);
  });

  it('reads List-Id and List-Unsubscribe as a mailing list', () => {
    assert.equal(focusHeaderSignals([{ key: 'list-id', value: '<news.example.org>' }])?.mailingList, true);
    assert.equal(focusHeaderSignals([{ key: 'list-unsubscribe', value: '<mailto:leave@example.org>' }])?.mailingList, true);
    assert.equal(focusHeaderSignals([{ key: 'list-unsubscribe', value: '' }])?.mailingList, false);
    assert.equal(focusHeaderSignals([{ key: 'list-post', value: '<mailto:list@example.org>' }])?.mailingList, false);
  });

  it('reads Precedence bulk, list and junk only', () => {
    for (const value of ['bulk', 'List', 'junk ']) {
      assert.equal(focusHeaderSignals([{ key: 'precedence', value }])?.bulkPrecedence, true, value);
    }
    for (const value of ['first-class', 'normal', 'bulky', '']) {
      assert.equal(focusHeaderSignals([{ key: 'precedence', value }])?.bulkPrecedence, false, value);
    }
  });

  it('reads a delivery-status report from the message\'s own Content-Type only', () => {
    assert.equal(focusHeaderSignals([{ key: 'content-type', value: 'multipart/report; report-type=delivery-status; boundary="x"' }])?.deliveryReport, true);
    assert.equal(focusHeaderSignals([{ key: 'content-type', value: 'multipart/report; report-type="delivery-status"' }])?.deliveryReport, true);
    assert.equal(focusHeaderSignals([{ key: 'content-type', value: 'multipart/report; report-type=disposition-notification' }])?.deliveryReport, false);
    assert.equal(focusHeaderSignals([{ key: 'content-type', value: 'text/plain; report-type=delivery-status' }])?.deliveryReport, false);
    assert.equal(focusHeaderSignals([
      { key: 'content-type', value: 'text/plain' },
      { key: 'content-type', value: 'multipart/report; report-type=delivery-status' },
    ])?.deliveryReport, false);
  });

  it('ignores malformed entries and unrelated headers', () => {
    assert.deepEqual(focusHeaderSignals([
      { key: 'subject', value: 'List-Id: <x>' },
      null as never,
      { key: 'precedence' } as never,
    ]), NONE);
  });
});

describe('classifyFocus: each signal', () => {
  it('defaults to Focused', () => {
    assert.deepEqual(classify({}), { focusClass: 'focused', reason: 'default' });
  });
  it('sender override', () => {
    assert.deepEqual(classify({ addressOverride: 'other' }), { focusClass: 'other', reason: 'sender_override' });
    assert.deepEqual(classify({ addressOverride: 'focused', signals: { ...NONE, mailingList: true } }), { focusClass: 'focused', reason: 'sender_override' });
  });
  it('domain override', () => {
    assert.deepEqual(classify({ domainOverride: 'other' }), { focusClass: 'other', reason: 'domain_override' });
    assert.deepEqual(classify({ domainOverride: 'focused', signals: { ...NONE, bulkPrecedence: true } }), { focusClass: 'focused', reason: 'domain_override' });
  });
  it('delivery report', () => {
    assert.deepEqual(classify({ signals: { ...NONE, deliveryReport: true, autoSubmitted: true } }), { focusClass: 'focused', reason: 'delivery_report' });
  });
  it('Auto-Submitted', () => {
    assert.deepEqual(classify({ signals: { ...NONE, autoSubmitted: true } }), { focusClass: 'other', reason: 'auto_submitted' });
  });
  it('mailing list', () => {
    assert.deepEqual(classify({ signals: { ...NONE, mailingList: true } }), { focusClass: 'other', reason: 'mailing_list' });
  });
  it('bulk precedence', () => {
    assert.deepEqual(classify({ signals: { ...NONE, bulkPrecedence: true } }), { focusClass: 'other', reason: 'bulk_precedence' });
  });
  it('correspondent', () => {
    assert.deepEqual(classify({ correspondent: true, sender: 'noreply@partner.example.org' }), { focusClass: 'focused', reason: 'correspondent' });
  });
  it('a correspondent beats List-Id / List-Unsubscribe and Precedence, but not Auto-Submitted', () => {
    assert.deepEqual(classify({ correspondent: true, signals: { ...NONE, mailingList: true, bulkPrecedence: true } }), { focusClass: 'focused', reason: 'correspondent' });
    assert.deepEqual(classify({ correspondent: true, signals: { ...NONE, autoSubmitted: true } }), { focusClass: 'other', reason: 'auto_submitted' });
  });
  it('an unauthenticated (possibly forged) From is never a correspondent or internal', () => {
    assert.deepEqual(classify({ senderAuthenticated: false, correspondent: true, signals: { ...NONE, mailingList: true } }), { focusClass: 'other', reason: 'mailing_list' });
    assert.deepEqual(classify({ senderAuthenticated: false, correspondent: true }), { focusClass: 'focused', reason: 'default' });
    assert.deepEqual(classify({ senderAuthenticated: false, sender: 'noreply@example.test' }), { focusClass: 'other', reason: 'automated_sender' });
    assert.deepEqual(classify({ senderAuthenticated: false, sender: 'ceo@example.test' }), { focusClass: 'focused', reason: 'default' });
  });
  it('a shared mailbox never uses the frequent-sender signal', () => {
    assert.deepEqual(classify({ sharedMailbox: true, recentFromSender: 500 }), { focusClass: 'focused', reason: 'default' });
  });
  it('internal sender (same MAIL_DOMAIN, exactly)', () => {
    assert.deepEqual(classify({ sender: 'noreply@example.test' }), { focusClass: 'focused', reason: 'internal' });
    assert.deepEqual(classify({ sender: 'noreply@sub.example.test' }), { focusClass: 'other', reason: 'automated_sender' });
    assert.deepEqual(classify({ sender: 'pat@example.test', mailDomain: '' }), { focusClass: 'focused', reason: 'default' });
  });
  it('automated sender', () => {
    assert.deepEqual(classify({ sender: 'no-reply@partner.example.org' }), { focusClass: 'other', reason: 'automated_sender' });
  });
  it('frequent sender, at the threshold and not below it', () => {
    assert.deepEqual(classify({ recentFromSender: FREQUENT_SENDER_THRESHOLD }), { focusClass: 'other', reason: 'frequent_sender' });
    assert.deepEqual(classify({ recentFromSender: FREQUENT_SENDER_THRESHOLD - 1 }), { focusClass: 'focused', reason: 'default' });
  });
  it('without headers (internal delivery, one-off sort) the header signals are simply not used', () => {
    assert.deepEqual(classify({ signals: null }), { focusClass: 'focused', reason: 'default' });
    assert.deepEqual(classify({ signals: null, sender: 'newsletter@partner.example.org' }), { focusClass: 'other', reason: 'automated_sender' });
  });
});

describe('classifyFocus: precedence', () => {
  const everything: Partial<FocusFacts> = {
    signals: { deliveryReport: true, autoSubmitted: true, mailingList: true, bulkPrecedence: true },
    correspondent: true,
    sender: 'noreply@example.test',
    recentFromSender: 999,
  };
  it('address override beats domain override beats everything else', () => {
    assert.equal(classify({ ...everything, addressOverride: 'other', domainOverride: 'focused' }).reason, 'sender_override');
    assert.equal(classify({ ...everything, domainOverride: 'other' }).reason, 'domain_override');
  });
  it('then delivery report, Auto-Submitted, correspondent, list, Precedence', () => {
    assert.equal(classify(everything).reason, 'delivery_report');
    const s = everything.signals!;
    assert.equal(classify({ ...everything, signals: { ...s, deliveryReport: false } }).reason, 'auto_submitted');
    assert.equal(classify({ ...everything, signals: { ...s, deliveryReport: false, autoSubmitted: false } }).reason, 'correspondent');
    assert.equal(classify({ ...everything, correspondent: false, signals: { ...s, deliveryReport: false, autoSubmitted: false } }).reason, 'mailing_list');
    assert.equal(classify({ ...everything, correspondent: false, signals: { ...NONE, bulkPrecedence: true } }).reason, 'bulk_precedence');
  });
  it('then internal, automated, frequent', () => {
    assert.equal(classify({ ...everything, signals: NONE, correspondent: false }).reason, 'internal');
    assert.equal(classify({ ...everything, signals: NONE, correspondent: false, sender: 'noreply@partner.example.org' }).reason, 'automated_sender');
    assert.equal(classify({ ...everything, signals: NONE, correspondent: false, sender: 'pat@partner.example.org' }).reason, 'frequent_sender');
  });
  it('every reason code has a plain explanation and fits the column', () => {
    for (const reason of FOCUS_REASONS) {
      assert.ok(FOCUS_REASON_TEXT[reason].length > 10, reason);
      assert.ok(reason.length <= 32, reason);
      assert.ok(isFocusReason(reason));
    }
    assert.equal(isFocusReason('made_up'), false);
  });
});

describe('focusScansNeeded: skip scans a header or the sender already decides', () => {
  const base = { sender: 'pat@partner.example.org', mailDomain: 'example.test', signals: NONE, senderAuthenticated: true };
  it('runs both scans when nothing else decides', () => {
    assert.deepEqual(focusScansNeeded(base), { correspondent: true, frequent: true });
  });
  it('never scans Sent for an unauthenticated sender', () => {
    assert.equal(focusScansNeeded({ ...base, senderAuthenticated: false }).correspondent, false);
  });
  it('skips both after a delivery report or Auto-Submitted, and the count after list headers', () => {
    assert.deepEqual(focusScansNeeded({ ...base, signals: { ...NONE, autoSubmitted: true } }), { correspondent: false, frequent: false });
    assert.deepEqual(focusScansNeeded({ ...base, signals: { ...NONE, deliveryReport: true } }), { correspondent: false, frequent: false });
    assert.deepEqual(focusScansNeeded({ ...base, signals: { ...NONE, mailingList: true } }), { correspondent: true, frequent: false });
  });
  it('skips the count for automated-looking and authenticated internal senders', () => {
    assert.equal(focusScansNeeded({ ...base, sender: 'noreply@partner.example.org' }).frequent, false);
    assert.equal(focusScansNeeded({ ...base, sender: 'pat@example.test' }).frequent, false);
    assert.equal(focusScansNeeded({ ...base, sender: 'pat@example.test', senderAuthenticated: false }).frequent, true);
  });
});

describe('addresses and domains', () => {
  it('isAutomatedSender', () => {
    for (const address of ['noreply@x.example', 'no-reply@x.example', 'no_reply+abc@x.example', 'DoNotReply@x.example',
      'do-not-reply@x.example', 'noreply-dmarc-support@x.example', 'notifications@x.example', 'notification@x.example',
      'newsletter@x.example', 'news@x.example', 'marketing@x.example', 'mailer@x.example']) {
      assert.equal(isAutomatedSender(address), true, address);
    }
    for (const address of ['pat@x.example', 'reply@x.example', 'newsroom@x.example', 'info@x.example', 'mailer-daemon@x.example', 'noreply', '@x.example']) {
      assert.equal(isAutomatedSender(address), false, address);
    }
  });

  it('normalizeFocusDomain', () => {
    assert.equal(normalizeFocusDomain(' @Example.ORG '), 'example.org');
    assert.equal(normalizeFocusDomain('*.news.example.org'), 'news.example.org');
    assert.equal(normalizeFocusDomain('example.org.'), 'example.org');
    for (const bad of ['', 'localhost', 'exa mple.org', '-x.example.org', 'x-.example.org', 'a..b', 'ex_ample.org', 'ü.example.org', 7, null, 'a'.repeat(64) + '.org']) {
      assert.equal(normalizeFocusDomain(bad), null, String(bad));
    }
  });

  it('normalizeFocusAddress', () => {
    assert.equal(normalizeFocusAddress(' Pat@Partner.Example.ORG '), 'pat@partner.example.org');
    for (const bad of ['', 'pat', '@example.org', 'pat@', 'pat@localhost', 'p at@example.org', 'pat@exa\nmple.org',`${'a'.repeat(320)}@example.org`, 5]) {
      assert.equal(normalizeFocusAddress(bad), null, String(bad));
    }
  });

  it('senderDomain and focusDomainCandidates', () => {
    assert.equal(senderDomain('"a@b"@Example.org'), 'example.org');
    assert.equal(senderDomain('nobody'), '');
    assert.deepEqual(focusDomainCandidates('mail.news.example.org'), ['mail.news.example.org', 'news.example.org', 'example.org']);
    assert.deepEqual(focusDomainCandidates('example.org'), ['example.org']);
    assert.deepEqual(focusDomainCandidates('org'), []);
    assert.equal(focusDomainCandidates(Array.from({ length: 20 }, (_, i) => `l${i}`).join('.')).length, 10);
  });

  it('isFocusClass', () => {
    assert.equal(isFocusClass('focused'), true);
    assert.equal(isFocusClass('other'), true);
    assert.equal(isFocusClass('Other'), false);
    assert.equal(isFocusClass(null), false);
  });
});
