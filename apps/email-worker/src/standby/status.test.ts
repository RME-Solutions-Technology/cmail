import { describe, expect, it } from 'vitest';
import { standbyConfig, standbyPrimaryAddress, standbyStatusView, type StandbyRun } from '@cmail/shared/standby';
import { probeTokenFrom } from './standby';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function run(overrides: Partial<StandbyRun>): StandbyRun {
  return {
    id: 'r', kind: 'schedule', status: 'pass', reason: '', detail: '', warnings: [],
    startedAt: NOW - HOUR, sentAt: null, receivedAt: NOW - HOUR + 3000, roundTripMs: 3000, lateMs: null, repeats: 1,
    folder: 'inbox', spf: 'pass', dkim: 'pass', dmarc: 'pass',
    ...overrides,
  };
}

const view = (runs: StandbyRun[], enabled = true) => standbyStatusView({ enabled, runs, now: NOW, timeoutMinutes: 10 });

describe('standby configuration', () => {
  it('defaults the label, probe address and timeout', () => {
    expect(standbyConfig({ MAIL_DOMAIN: 'Example.TEST ' })).toEqual({
      configured: true,
      config: {
        mailDomain: 'example.test', label: 'standby', standbyDomain: 'standby.example.test',
        probeAddress: 'cmail-standby-probe@example.test', probeStandbyAddress: 'cmail-standby-probe@standby.example.test',
        timeoutMinutes: 10,
      },
    });
  });

  it('names bad settings without echoing their values, and clamps the timeout', () => {
    const bad = standbyConfig({ MAIL_DOMAIN: 'example.test', STANDBY_SUBDOMAIN_LABEL: 'a.b', STANDBY_PROBE_LOCAL_PART: 'x y' });
    expect(bad).toEqual({ configured: false, problems: [expect.stringContaining('STANDBY_SUBDOMAIN_LABEL'), expect.stringContaining('STANDBY_PROBE_LOCAL_PART')] });
    expect(JSON.stringify(bad)).not.toContain('a.b');
    expect(standbyConfig({ MAIL_DOMAIN: 'example.test', STANDBY_PROBE_TIMEOUT_MINUTES: '999' })).toMatchObject({ config: { timeoutMinutes: 60 } });
    expect(standbyConfig({ MAIL_DOMAIN: 'example.test', STANDBY_PROBE_TIMEOUT_MINUTES: '1' })).toMatchObject({ config: { timeoutMinutes: 2 } });
    expect(standbyConfig({ MAIL_DOMAIN: 'example.test', STANDBY_PROBE_TIMEOUT_MINUTES: 'soon' })).toMatchObject({ config: { timeoutMinutes: 10 } });
  });

  it('maps only an exact standby address to the primary address', () => {
    const config = { mailDomain: 'example.test', standbyDomain: 'standby.example.test' };
    expect(standbyPrimaryAddress('Alice@Standby.Example.Test', config)).toBe('alice@example.test');
    for (const address of ['alice@example.test', 'alice@x.standby.example.test', '@standby.example.test', 'a@b@standby.example.test', 'alice@standby.example.test.example']) {
      expect(standbyPrimaryAddress(address, config)).toBeNull();
    }
  });

  it('reads the probe token from the header, or the subject as a fallback, and nothing else', () => {
    const token = 'A'.repeat(43);
    expect(probeTokenFrom(new Headers({ 'X-Cmail-Standby-Probe': token }))).toBe(token);
    expect(probeTokenFrom(new Headers({ subject: `cmail standby test ${token}` }))).toBe(token);
    expect(probeTokenFrom(new Headers({ 'X-Cmail-Standby-Probe': 'short', subject: 'Hello' }))).toBeNull();
  });
});

describe('standby status light', () => {
  it('is off when switched off', () => {
    expect(view([run({})], false).light).toBe('off');
  });

  it('is green for a recent clean pass', () => {
    expect(view([run({})])).toMatchObject({ light: 'green', reason: '' });
  });

  it('is amber for a pass with a warning that matters, but not for unrecorded auth', () => {
    expect(view([run({ warnings: ['spam_folder'] })])).toMatchObject({ light: 'amber', reason: 'spam_folder' });
    expect(view([run({ warnings: ['dmarc_not_pass'] })]).light).toBe('amber');
    expect(view([run({ warnings: ['auth_not_recorded'] })]).light).toBe('green');
  });

  it('turns amber, then red, as the last pass gets old', () => {
    expect(view([run({ startedAt: NOW - 27 * HOUR, receivedAt: NOW - 27 * HOUR })])).toMatchObject({ light: 'amber', reason: 'stale' });
    expect(view([run({ startedAt: NOW - 51 * HOUR, receivedAt: NOW - 51 * HOUR })])).toMatchObject({ light: 'red', reason: 'stale' });
  });

  it('is red with the exact reason when the newest test failed', () => {
    const result = view([
      run({ id: 'new', status: 'fail', reason: 'send_rejected', detail: 'E_SENDER_NOT_VERIFIED', startedAt: NOW - 10 * 60 * 1000, receivedAt: null }),
      run({ id: 'old', startedAt: NOW - 20 * HOUR }),
    ]);
    expect(result).toMatchObject({ light: 'red', reason: 'send_rejected', last: { id: 'new' } });
  });

  it('keeps the last result while a test runs, and goes red once it is overdue', () => {
    const running = run({ id: 'run', status: 'waiting', startedAt: NOW - 60 * 1000, receivedAt: null, roundTripMs: null });
    expect(view([running, run({ id: 'old' })])).toMatchObject({ light: 'green', running: { id: 'run' } });
    expect(view([running])).toMatchObject({ light: 'amber', reason: 'running' });
    const overdue = { ...running, startedAt: NOW - 11 * 60 * 1000 };
    expect(view([overdue, run({ id: 'old' })])).toMatchObject({ light: 'red', reason: 'timeout' });
  });

  it('is amber before the first test', () => {
    expect(view([])).toMatchObject({ light: 'amber', reason: 'never' });
  });
});
