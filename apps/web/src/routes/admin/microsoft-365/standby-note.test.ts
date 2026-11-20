import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { STANDBY_SWITCH_SOONER_NOTE, emptyGraphMirrorStatus } from '@cmail/shared/graph-mirror';
import MailFeed from './sections/MailFeed.svelte';
import StandbyLink from './sections/StandbyLink.svelte';
import StandbyPage from '../standby/+page.svelte';

// The "switch sooner" note (if Exchange is down, nothing new arrives here
// until the switch) must render next to the standby controls and on the
// Exchange mirror page, whatever state the features are in.

const NOW = Date.parse('2026-11-16T05:00:00Z');

function escaped(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
}

function mirrorOverview(enabled: boolean) {
  return {
    graph: {
      enabled,
      installed: true,
      config: { state: 'configured', folders: ['inbox', 'sentitems', 'archive'], lookbackHours: 24, initialCap: 500 },
      status: { ...emptyGraphMirrorStatus(), mailboxes: 3, lastRunAt: NOW },
      import: { estimate: null, figures: null, mailboxes: [], job: null, requestPending: null },
    },
    enabled: false,
    colleagueSend: false,
    aliasEnabled: false,
    installed: true,
    config: { state: 'unknown' },
    days: [],
    lastReportAt: null,
    sync: { enabled: true, dryRun: false },
    aliasState: null,
    aliasCount: 0,
    aliasesFresh: false,
    now: NOW,
  };
}

describe('standby "switch sooner" note', () => {
  it('says plainly that mail is not received here until the switch, and that senders retry', () => {
    expect(STANDBY_SWITCH_SOONER_NOTE).toMatch(/^If Exchange is down, switch as soon as you can: until you switch, new mail is not received here either/);
    expect(STANDBY_SWITCH_SOONER_NOTE).toContain('held and retried by the sender');
  });

  it('renders in the Mail feed section (Graph source on or off) with the Graph controls', () => {
    for (const enabled of [false, true]) {
      const { body } = render(MailFeed, { props: { data: { overview: mirrorOverview(enabled), appName: 'cmail' }, form: null } as never });
      expect(body).toContain('data-testid="standby-sooner-note"');
      expect(body.includes(STANDBY_SWITCH_SOONER_NOTE) || body.includes(escaped(STANDBY_SWITCH_SOONER_NOTE))).toBe(true);
      expect(body).toContain('Graph source (recommended)');
      expect(body).toContain('not recommended with Cloudflare Email Routing');
      expect(body.includes('value="graph_run_now"')).toBe(enabled);
    }
  });

  it('renders on the Microsoft 365 page link card to Standby', () => {
    const { body } = render(StandbyLink, { props: {} });
    expect(body).toContain('data-testid="standby-link-note"');
    expect(body.includes(STANDBY_SWITCH_SOONER_NOTE) || body.includes(escaped(STANDBY_SWITCH_SOONER_NOTE))).toBe(true);
    expect(body).toContain('href="/admin/standby"');
  });

  it('renders on Admin > Standby, even when that page has nothing else to show', () => {
    const { body } = render(StandbyPage, { props: { data: { overview: null, appName: 'cmail' }, form: null } as never });
    expect(body).toContain('data-testid="standby-sooner-note"');
    expect(body.includes(STANDBY_SWITCH_SOONER_NOTE) || body.includes(escaped(STANDBY_SWITCH_SOONER_NOTE))).toBe(true);
  });
});
