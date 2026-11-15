<script lang="ts">
  import { EXCHANGE_MIRROR_REASON_TEXT } from '@cmail/shared/exchange-mirror';

  let { data, form } = $props();
  const overview = $derived(data.overview);
  const today = $derived(overview && overview.days[0]?.day === new Date(overview.now).toISOString().slice(0, 10) ? overview.days[0] : null);

  function when(ms: number | null | undefined): string {
    return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
  }
  function reasonText(code: string): string {
    return EXCHANGE_MIRROR_REASON_TEXT[code] ?? code;
  }
  const ALIAS_RESULT: Record<string, string> = {
    ok: 'Imported',
    dry_run: 'Dry run (nothing written)',
    held: 'Held: Microsoft 365 returned no aliases, so none were removed',
    error: 'Failed',
    not_configured: 'Microsoft 365 sync settings are missing',
  };
</script>

<svelte:head><title>Exchange mirror · Management · {data.appName || 'cmail'}</title></svelte:head>

<section class="mirror-page" aria-labelledby="mirror-heading">
  <header class="page-heading">
    <p class="eyebrow">Mail</p>
    <h1 id="mirror-heading">Exchange mirror</h1>
    <p>Keeps cmail a live copy of your Exchange Online mail. One Exchange journal rule sends a copy of every message to one secret address; cmail files the original into each person's mailbox (and the sender's Sent). Off by default. Nothing here changes how cmail receives its own mail.</p>
  </header>

  {#if form?.error}<div class="notice notice-error" role="alert">{form.error}</div>{/if}
  {#if form?.success}<div class="notice notice-success" role="status">{form.success}</div>{/if}

  {#if !overview}
    <p class="muted">Not available in this environment.</p>
  {:else}
    {#if !overview.installed}
      <div class="notice notice-error" role="alert">Database migration 0027 has not been applied. Run <code>pnpm db:migrate</code> first.</div>
    {/if}
    {#if overview.config.state === 'not_configured'}
      <div class="notice notice-warning" role="status">
        <strong>Not configured.</strong> The email Worker needs these settings first:
        <ul>{#each overview.config.problems as problem}<li>{problem}</li>{/each}</ul>
        See the Exchange mirror guide.
      </div>
    {:else if overview.config.state === 'unknown'}
      <p class="muted">The email Worker could not be asked about its settings. If they are missing, it refuses every journal report.</p>
    {/if}

    <section class="card" aria-labelledby="switch-heading">
      <div class="switch-head">
        <div>
          <h2 id="switch-heading">Exchange mirror</h2>
          <p class="muted">Off means mail to the journal address is refused like any unknown address and nothing is filed.</p>
        </div>
        <span class="state-badge" class:on={overview.enabled}>{overview.enabled ? 'On' : 'Off'}</span>
      </div>
      <form method="POST">
        <input type="hidden" name="action" value={overview.enabled ? 'disable' : 'enable'} />
        <button type="submit" class="btn {overview.enabled ? 'btn-outline-danger' : 'btn-primary'}"
          disabled={!overview.enabled && (!overview.installed || overview.config.state === 'not_configured')}>
          {overview.enabled ? 'Turn Exchange mirror off' : 'Turn Exchange mirror on'}
        </button>
      </form>
      {#if overview.config.state === 'configured'}
        <dl class="facts">
          <div><dt>Journal address</dt><dd><code>{overview.config.maskedAddress}</code> (full address in the Worker settings only)</dd></div>
          <div><dt>Trusted sender domains</dt><dd>{overview.config.senderDomains.join(', ')}</dd></div>
          <div><dt>SPF/DKIM/DMARC check</dt><dd>{overview.config.requireAuth ? 'Required' : 'Off (weaker: token and headers only)'}</dd></div>
          <div><dt>Tenant check</dt><dd>{overview.config.tenantCheck ? 'On (M365_TENANT_ID)' : 'Off: set M365_TENANT_ID'}</dd></div>
          <div><dt>Sent copies</dt><dd>{overview.config.mirrorSent ? 'Filed for cmail users who sent through Exchange' : 'Off'}</dd></div>
        </dl>
      {/if}
    </section>

    <section class="card" aria-labelledby="status-heading">
      <h2 id="status-heading">Status</h2>
      <dl class="facts">
        <div><dt>Last journal report</dt><dd>{when(overview.lastReportAt)}</dd></div>
        <div><dt>Received today</dt><dd>{today?.received ?? 0}</dd></div>
        <div><dt>Filed today</dt><dd>{today?.filed ?? 0} to recipients, {today?.sentFiled ?? 0} to Sent</dd></div>
        <div><dt>Duplicates today</dt><dd>{today?.duplicates ?? 0}</dd></div>
        <div><dt>Unmatched recipients today</dt><dd>{today?.unmatched ?? 0}</dd></div>
        <div><dt>Not filed today</dt><dd>{today?.skipped ?? 0} copies skipped, {today?.rejected ?? 0} reports refused</dd></div>
      </dl>
      {#if today?.lastProblem}
        <p class="muted">Latest problem ({when(today.lastProblemAt)}): <code>{today.lastProblem}</code> {reasonText(today.lastProblem)}</p>
      {/if}
      {#if overview.days.length}
        <div class="table-wrap">
          <table>
            <thead><tr><th>Day (UTC)</th><th>Received</th><th>Filed</th><th>Sent</th><th>Duplicates</th><th>Unmatched</th><th>Skipped</th><th>Refused</th></tr></thead>
            <tbody>
              {#each overview.days as day (day.day)}
                <tr><td>{day.day}</td><td>{day.received}</td><td>{day.filed}</td><td>{day.sentFiled}</td><td>{day.duplicates}</td><td>{day.unmatched}</td><td>{day.skipped}</td><td>{day.rejected}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="muted">No journal reports in the last 7 days.</p>
      {/if}
      <p class="muted">Unmatched recipients are people outside this organisation, or addresses with no active cmail mailbox or alias. Refused reports and skipped copies are in the audit log.</p>
    </section>

    <section class="card" aria-labelledby="alias-heading">
      <div class="switch-head">
        <div>
          <h2 id="alias-heading">Aliases from Microsoft 365</h2>
          <p class="muted">Imports each synced person's and shared mailbox's extra addresses (proxyAddresses on your mail domain), so mirrored mail sent to an alias is filed. Needs the Microsoft 365 sync on and out of dry run. Only the Exchange mirror uses these aliases.</p>
        </div>
        <span class="state-badge" class:on={overview.aliasEnabled}>{overview.aliasEnabled ? 'On' : 'Off'}</span>
      </div>
      <form method="POST">
        <input type="hidden" name="action" value={overview.aliasEnabled ? 'alias_disable' : 'alias_enable'} />
        <button type="submit" class="btn {overview.aliasEnabled ? 'btn-outline-danger' : 'btn-primary'}" disabled={!overview.aliasEnabled && !overview.installed}>
          {overview.aliasEnabled ? 'Turn alias import off' : 'Turn alias import on'}
        </button>
      </form>
      {#if overview.aliasEnabled && (!overview.sync.enabled || overview.sync.dryRun)}
        <div class="notice notice-warning" role="status">The Microsoft 365 sync is {overview.sync.enabled ? 'in dry run' : 'off'}, so aliases are {overview.sync.enabled ? 'only counted, not written' : 'not imported'}.</div>
      {/if}
      <dl class="facts">
        <div><dt>Aliases held</dt><dd>{overview.aliasCount}</dd></div>
        <div><dt>Last import</dt><dd>{when(overview.aliasState?.lastRunAt)}{overview.aliasState?.lastResult ? `: ${ALIAS_RESULT[overview.aliasState.lastResult] ?? overview.aliasState.lastResult}` : ''}{overview.aliasState?.lastError ? ` (${overview.aliasState.lastError})` : ''}</dd></div>
        {#if overview.aliasState?.counts}
          <div><dt>Last import changes</dt><dd>{overview.aliasState.counts.added} added, {overview.aliasState.counts.moved} moved, {overview.aliasState.counts.removed} removed, {overview.aliasState.counts.conflicts} refused (address in use or claimed twice)</dd></div>
        {/if}
      </dl>
    </section>
  {/if}
</section>

<style>
  .mirror-page { display: grid; gap: 20px; max-width: 960px; }
  .page-heading h1 { margin: 2px 0 6px; font-size: var(--fs-title-2); font-weight: 600; }
  .page-heading > p:last-child { max-width: 760px; color: var(--text-muted); font-size: var(--fs-body); font-weight: 400; }
  .eyebrow { margin: 0; }
  h2 { margin: 0 0 4px; font-size: var(--fs-subtitle); font-weight: 600; }
  .muted { margin: 0; color: var(--text-muted); font-size: 13px; }
  .notice { padding: 8px 12px; border: 0; border-left: 3px solid; border-radius: 0; }
  .notice ul { margin: 6px 0; padding-left: 18px; }
  .notice-error { color: var(--danger); background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 28%, var(--border)); }
  .notice-success { color: var(--success); background: var(--success-soft); border-color: color-mix(in srgb, var(--success) 28%, var(--border)); }
  .notice-warning { color: var(--text); background: var(--bg-subtle); border-color: var(--border); }
  .card { display: grid; gap: 12px; padding: 0 0 8px; border: 0; border-radius: 0; background: none; }
  .switch-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  .state-badge { flex: 0 0 auto; padding: 3px 10px; border-radius: var(--radius-pill); background: var(--bg-subtle); color: var(--text-muted); font-size: 12px; font-weight: 650; }
  .state-badge.on { background: var(--success-soft); color: var(--success); }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 24px; margin: 0; }
  .facts dt { color: var(--text-muted); font-size: 12px; }
  .facts dd { margin: 2px 0 0; font-size: 13px; overflow-wrap: anywhere; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { padding: 6px 8px; text-align: left; }
</style>
