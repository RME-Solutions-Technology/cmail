<script lang="ts">
  // A read-only summary of what the sections below already check. It adds no
  // new reads: every value comes from the same overviews those sections use.
  let { data } = $props();
  const appName = $derived(data.appName || 'cmail');
  const sync = $derived(data.sync);
  const access = $derived(data.access);
  const graph = $derived(data.feed?.graph);

  type Level = 'ok' | 'warn' | 'bad' | 'idle';
  type Row = { label: string; level: Level; text: string; detail?: string };
  const LEVEL_TEXT: Record<Level, string> = { ok: 'OK', warn: 'Check', bad: 'Missing', idle: 'Not checked yet' };

  function when(ms: number | string | null | undefined): string {
    if (!ms) return 'not yet';
    const iso = typeof ms === 'number' ? new Date(ms).toISOString() : ms;
    return iso.replace('T', ' ').slice(0, 16) + ' UTC';
  }

  const rows = $derived.by((): Row[] => {
    const out: Row[] = [];
    if (sync) {
      const config = sync.config;
      out.push(config.state === 'configured'
        ? { label: 'Sync app settings', level: 'ok', text: 'Configured on the email Worker' }
        : config.state === 'not_configured'
          ? { label: 'Sync app settings', level: 'bad', text: 'Not configured', detail: config.problems.join('; ') }
          : { label: 'Sync app settings', level: 'idle', text: 'The email Worker could not be asked' });
      const domains = sync.orgDomains;
      out.push(domains.problem === 'permission_missing'
        ? { label: 'Domain.Read.All (domain read)', level: 'bad', text: 'Permission missing', detail: 'Grant the sync app Domain.Read.All (application) with admin consent.' }
        : domains.problem
          ? { label: 'Domain.Read.All (domain read)', level: 'warn', text: `The last read failed (${domains.problem})` }
          : domains.refreshedAt
            ? { label: 'Domain.Read.All (domain read)', level: 'ok', text: `Read ${when(domains.refreshedAt)}` }
            : { label: 'Domain.Read.All (domain read)', level: 'idle', text: 'Not read yet' });
      if (sync.unreadableLinked > 0) {
        out.push({ label: 'MailboxSettings.Read (mailbox type)', level: 'bad', text: `Not readable for ${sync.unreadableLinked}`, detail: 'Check the permission and its admin consent.' });
      } else if (sync.status?.sharedDetection === true) {
        out.push({ label: 'MailboxSettings.Read (mailbox type)', level: 'ok', text: 'Mailbox type readable' });
      }
    }
    if (graph) {
      const status = graph.status;
      out.push(status?.permissionMissing
        ? { label: 'Mail.Read (Exchange role)', level: 'bad', text: 'Graph refused every mailbox', detail: 'Assign "Application Mail.Read" to the app in Exchange Online.' }
        : status && status.denied > 0
          ? { label: 'Mail.Read (Exchange role)', level: 'warn', text: `${status.denied} mailbox${status.denied === 1 ? ' is' : 'es are'} outside the app's scope` }
          : status && status.mailboxes > 0
            ? { label: 'Mail.Read (Exchange role)', level: 'ok', text: `In scope for ${status.mailboxes} mailbox${status.mailboxes === 1 ? '' : 'es'}` }
            : { label: 'Mail.Read (Exchange role)', level: 'idle', text: graph.enabled ? 'No run yet' : 'Mail feed is off' });
    }
    if (access) {
      const config = access.config;
      const failing = access.status?.alert === true;
      out.push(config.state === 'not_configured'
        ? { label: 'Exchange permissions collector', level: 'bad', text: 'Not configured', detail: config.problems.join('; ') }
        : failing
          ? { label: 'Exchange permissions collector', level: 'bad', text: 'Failing', detail: 'See Shared mailbox access below.' }
          : config.state === 'configured'
            ? { label: 'Exchange permissions collector', level: 'ok', text: 'Configured' }
            : { label: 'Exchange permissions collector', level: 'idle', text: 'The email Worker could not be asked' });
    }
    return out;
  });
  const domains = $derived(sync?.orgDomains?.domains ?? []);
</script>

<section class="m365-section" aria-labelledby="connection-title">
  <header class="section-heading">
    <h2 id="connection-title">Connection</h2>
    <p>The Microsoft 365 app {appName} reads with, and whether each permission it needs is in place. These are the checks the sections below already make, gathered in one place.</p>
  </header>

  {#if !sync && !access && !graph}
    <p class="muted">Not available in this environment.</p>
  {:else}
    <ul class="checks">
      {#each rows as row (row.label)}
        <li>
          <span class="check-label">{row.label}</span>
          <span class="check-state" data-level={row.level}><span class="check-badge">{LEVEL_TEXT[row.level]}</span> {row.text}</span>
          {#if row.detail}<span class="muted check-detail">{row.detail}</span>{/if}
        </li>
      {/each}
    </ul>
    <div>
      <h3 class="domains-heading">Discovered domains</h3>
      <p class="muted" data-testid="m365-domains">{domains.length ? domains.join(', ') : 'No verified domains read yet. The mail domain setting is used on its own.'}</p>
    </div>
  {/if}
</section>

<style>
  .m365-section { display: grid; gap: 14px; }
  .section-heading h2 { margin: 0 0 6px; font-size: var(--fs-title-3, var(--fs-subtitle)); font-weight: 600; }
  .section-heading p { max-width: 760px; margin: 0; color: var(--text-muted); font-size: var(--fs-body); font-weight: 400; }
  .muted { margin: 0; color: var(--text-muted); font-size: 13px; }
  .checks { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .checks li { display: grid; grid-template-columns: minmax(180px, 1fr) 2fr; gap: 2px 16px; font-size: 13px; }
  .check-label { color: var(--text-muted); }
  .check-detail { grid-column: 2; }
  .check-badge { display: inline-block; padding: 1px 8px; border-radius: var(--radius-pill); background: var(--bg-subtle); font-size: 12px; font-weight: 650; }
  [data-level='ok'] .check-badge { background: var(--success-soft); color: var(--success); }
  [data-level='bad'] .check-badge { background: var(--danger-soft); color: var(--danger); }
  .domains-heading { margin: 0 0 4px; font-size: var(--fs-subtitle); font-weight: 600; }
  @media (max-width: 640px) {
    .checks li { grid-template-columns: 1fr; }
    .check-detail { grid-column: 1; }
  }
</style>
