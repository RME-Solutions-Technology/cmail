<script lang="ts">
  let { data, form } = $props();
  const overview = $derived(data.overview);
  const toggle = $derived(overview?.toggle);
  const status = $derived(overview?.status);
  const last = $derived(status?.lastRound ?? null);

  const ACTIONS: Record<string, [string, string]> = {
    add: ['Gave access', 'Would give access'],
    upgrade: ['Raised access', 'Would raise access'],
    downgrade: ['Lowered access', 'Would lower access'],
    remove: ['Removed access', 'Would remove access'],
    manager_kept: ['Set by a manager; left as is', 'Set by a manager; would leave as is'],
    manager_removed: ['Removed by a manager; not given back', 'Removed by a manager; would not give back'],
    not_representable: ['Send As without Full Access; no cmail equivalent', 'Send As without Full Access; no cmail equivalent'],
    mailbox_not_linked: ['Shared mailbox not in cmail yet', 'Shared mailbox not in cmail yet'],
    skipped: ['Skipped', 'Skipped'],
    conflict: ['Changed by someone else; left as is', 'Changed by someone else; left as is'],
  };
  const COUNT_LABELS: Array<[string, string]> = [
    ['added', 'Added'], ['upgraded', 'Raised'], ['downgraded', 'Lowered'], ['removed', 'Removed'],
    ['managerKept', 'Kept (manager)'], ['notRepresentable', 'No cmail equivalent'], ['trusteeNotLinked', 'Person not in cmail'],
    ['mailboxNotLinked', 'Mailbox not in cmail'], ['mailboxNotCovered', 'Mailbox not covered'], ['changedConcurrently', 'Changed meanwhile'], ['unchanged', 'Unchanged'],
  ];
  const BRAKE_TEXT: Record<string, string> = {
    too_many_removals: 'This run would remove or lower more access than the safety limit allows.',
    no_grants: 'Exchange listed shared mailboxes but not a single Full Access or Send As grant.',
    empty_snapshot: 'Exchange listed no shared mailboxes at all. This usually means a wrong tenant, a lost role or an outage, not that nobody has access.',
  };

  // What to do for each failure code shown in the alert.
  const ADVICE: Record<string, string> = {
    pass_too_long: 'The tenant has more shared mailboxes than one pass can read (24 batches of about 10 minutes). Nothing was changed. Ask the maintainers to raise the batch limit, or scope the reader app to fewer mailboxes.',
    credentials_rejected: 'The reader app rejected the certificate or its consent. Check the certificate expiry and the Exchange.ManageAsApp consent.',
    certificate_unreadable: 'The certificate secret could not be read. Check M365_EXO_CERT_PFX_B64 and M365_EXO_CERT_PASSWORD.',
    exchange_role_missing: 'The reader app is missing a cmdlet in its Exchange role group. Rerun setup step 3 and the step 4 go/no-go.',
    unauthorized: 'Exchange refused the reader app. Check its role group membership (setup step 3).',
    collector_timeout: 'The collector did not finish in time. It is tried again automatically.',
    bad_snapshot: 'The collector returned data that failed the checks. Nothing was changed; it is tried again automatically.',
  };
  const advice = $derived(status?.lastError ? ADVICE[status.lastError.code] ?? 'Check the guide for this code.' : '');

  function actionLabel(action: string, dryRun: boolean): string {
    const pair = ACTIONS[action];
    return pair ? pair[dryRun ? 1 : 0] : action;
  }
  function when(value: string | null | undefined): string {
    return value ? value.replace('T', ' ').slice(0, 16) + ' UTC' : 'never';
  }
</script>

<svelte:head><title>Shared mailbox access · Management · {data.appName || 'cmail'}</title></svelte:head>

<section class="sync-page" aria-labelledby="perms-heading">
  <header class="page-heading">
    <p class="eyebrow">Identity &amp; organisation</p>
    <h1 id="perms-heading">Shared mailbox access</h1>
    <p>Copy Full Access and Send As on shared mailboxes from Exchange Online into cmail, once a day. It only reads from Microsoft. It gives, raises, lowers or removes only access it gave itself; anything a manager set in Mailboxes is never changed. If Exchange cannot be read, nothing changes. Primary mail is not affected either way.</p>
  </header>

  {#if form?.error}<div class="notice notice-error" role="alert">{form.error}</div>{/if}
  {#if form?.success}<div class="notice notice-success" role="status">{form.success}</div>{/if}

  {#if !overview || !toggle}
    <p class="muted">Not available in this environment.</p>
  {:else}
    {#if !overview.installed}
      <div class="notice notice-error" role="alert">Database migration 0028 has not been applied. Run <code>pnpm db:migrate</code> first.</div>
    {/if}
    {#if overview.config.state === 'not_configured'}
      <div class="notice notice-warning" role="status">
        <strong>Not configured.</strong> The email Worker needs these settings before the collector can run:
        <ul>{#each overview.config.problems as problem}<li>{problem}</li>{/each}</ul>
        See the setup steps in the shared mailbox access guide.
      </div>
    {:else if overview.config.state === 'unknown'}
      <p class="muted">The email Worker could not be asked about its settings. If they are missing, the next run shows "not configured" here and changes nothing.</p>
    {/if}
    {#if overview.config.state !== 'unknown' && !overview.config.groups}
      <p class="muted">Microsoft 365 sync is not configured on the email Worker, so access given to groups cannot be expanded. Mailboxes with group grants are then left as they are.</p>
    {/if}

    {#if status?.alert}
      <div class="notice notice-error" role="alert">
        <strong>Collection failing.</strong> The last {status.consecutiveFailures} runs failed{status.lastError ? ` (${status.lastError.code})` : ''}. Every assignment was kept as it was. {advice}
      </div>
    {:else if status?.lastError?.code === 'pass_too_long'}
      <div class="notice notice-warning" role="status">{advice}</div>
    {/if}
    {#if overview.queuedUntil}
      <p class="muted" role="status">Sync access now is queued: it runs at about {when(overview.queuedUntil)} (one manual collection an hour).</p>
    {/if}

    <section class="card" aria-labelledby="switch-heading">
      <div class="switch-head">
        <div>
          <h2 id="switch-heading">Access sync</h2>
          <p class="muted">Off means the scheduled job does nothing: no container, no Microsoft call, no change.</p>
        </div>
        <span class="state-badge" class:on={toggle.enabled}>{toggle.enabled ? 'On' : 'Off'}</span>
      </div>
      <div class="switch-row">
        <form method="POST">
          <input type="hidden" name="action" value={toggle.enabled ? 'disable' : 'enable'} />
          <button type="submit" class="btn {toggle.enabled ? 'btn-outline-danger' : 'btn-primary'}"
            disabled={!toggle.enabled && (!overview.installed || overview.config.state === 'not_configured')}>
            {toggle.enabled ? 'Turn off' : 'Turn on'}
          </button>
        </form>
        <form method="POST">
          <input type="hidden" name="action" value={toggle.dryRun ? 'dry_run_off' : 'dry_run_on'} />
          <button type="submit" class="btn">{toggle.dryRun ? 'Turn dry run off (apply changes)' : 'Turn dry run on (report only)'}</button>
        </form>
        <form method="POST">
          <input type="hidden" name="action" value="sync_now" />
          <button type="submit" class="btn" disabled={!toggle.enabled}>Sync access now</button>
        </form>
      </div>
      <p class="muted">Dry run is <strong>{toggle.dryRun ? 'on' : 'off'}</strong>. {toggle.dryRun ? 'Runs only report what they would change.' : 'Runs apply changes and audit each one.'} A collection takes a few minutes; results show here after the next run.</p>
    </section>

    {#if status?.round?.phase === 'held' && status.round.brake}
      <section class="card held-card" aria-labelledby="held-heading">
        <h2 id="held-heading">Removals held for approval</h2>
        <p>{BRAKE_TEXT[status.round.brake.reason] ?? ''} {status.round.brake.removals} of {status.round.brake.ledger} sync-made grants ({status.round.brake.percent}%) would be removed or lowered. New access was still given; nothing was removed or lowered.</p>
        {#if status.round.report.length}
          <div class="table-wrap">
            <table>
              <thead><tr><th>Change</th><th>Shared mailbox</th><th>Person</th><th>Reason</th></tr></thead>
              <tbody>
                {#each status.round.report as item}
                  <tr><td>{actionLabel(item.action, false)}</td><td>{item.mailbox || '—'}</td><td>{item.user || '—'}</td><td><code>{item.reason}</code></td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        <div class="switch-row">
          {#if status.round.brake.reason !== 'empty_snapshot'}
            <form method="POST">
              <input type="hidden" name="action" value="approve_round" />
              <input type="hidden" name="round_id" value={status.round.id} />
              <button type="submit" class="btn btn-danger">Approve removals</button>
            </form>
          {/if}
          <form method="POST">
            <input type="hidden" name="action" value="sync_now" />
            <button type="submit" class="btn">Discard and collect again</button>
          </form>
        </div>
      </section>
    {/if}

    {#if status}
      <section class="card" aria-labelledby="status-heading">
        <h2 id="status-heading">Status</h2>
        <dl class="facts">
          <div><dt>Last check</dt><dd>{when(status.lastTickAt)}</dd></div>
          <div><dt>Result</dt><dd>{status.lastResult ?? 'not run yet'}{status.lastError ? ` (${status.lastError.code}, ${when(status.lastError.at)})` : ''}</dd></div>
          {#if status.backoffUntil}<div><dt>Next try after</dt><dd>{when(status.backoffUntil)}</dd></div>{/if}
          <div><dt>Last finished run</dt><dd>{when(status.lastFinishedAt)}</dd></div>
          <div><dt>Access given by the sync</dt><dd>{overview.syncOwned} {overview.syncOwned === 1 ? 'assignment' : 'assignments'}</dd></div>
          {#if status.round}<div><dt>In progress</dt><dd>{status.round.phase}{status.round.mode === 'dry_run' ? ' (dry run)' : ''}, started {when(status.round.startedAt)}</dd></div>{/if}
        </dl>
      </section>

      {#if last}
        <section class="card" aria-labelledby="report-heading">
          <h2 id="report-heading">Last run{last.mode === 'dry_run' ? ': dry run' : ''}</h2>
          <p class="muted">
            Finished {when(last.finishedAt)}.
            {#if last.snapshot}Exchange read at {when(last.snapshot.collectedAt)}: {last.snapshot.mailboxes} of {last.snapshot.mailboxesInTenant} shared mailboxes in {last.snapshot.batches ?? 1} {(last.snapshot.batches ?? 1) === 1 ? 'batch' : 'batches'}, {last.snapshot.grants} grants.{/if}
            {#if last.brake} {last.mode === 'dry_run' ? 'Live, removals would have been held for approval.' : 'Removals were held and then approved.'}{/if}
          </p>
          <ul class="counts">
            {#each COUNT_LABELS as [key, label]}
              <li><span>{label}</span><strong>{last.counts[key as keyof typeof last.counts] ?? 0}</strong></li>
            {/each}
          </ul>
          {#if last.report.length}
            <div class="table-wrap">
              <table>
                <thead><tr><th>Change</th><th>Shared mailbox</th><th>Person</th><th>Reason</th></tr></thead>
                <tbody>
                  {#each last.report as item}
                    <tr><td>{actionLabel(item.action, last.mode === 'dry_run')}</td><td>{item.mailbox || '—'}</td><td>{item.user || '—'}</td><td><code>{item.reason}</code></td></tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <p class="muted">No changes.</p>
          {/if}
        </section>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .sync-page { display: grid; gap: 20px; max-width: 960px; }
  .page-heading { display: block; }
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
  .held-card { padding: 12px; border-left: 3px solid var(--danger); background: var(--danger-soft); }
  .held-card p { margin: 0; font-size: 13px; }
  .switch-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  .switch-row { display: flex; flex-wrap: wrap; gap: 10px; }
  .state-badge { flex: 0 0 auto; padding: 3px 10px; border-radius: var(--radius-pill); background: var(--bg-subtle); color: var(--text-muted); font-size: 12px; font-weight: 650; }
  .state-badge.on { background: var(--success-soft); color: var(--success); }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 24px; margin: 0; }
  .facts dt { color: var(--text-muted); font-size: 12px; }
  .facts dd { margin: 2px 0 0; font-size: 13px; overflow-wrap: anywhere; }
  .counts { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 0; padding: 0; list-style: none; font-size: 13px; }
  .counts span { color: var(--text-muted); margin-right: 6px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { padding: 6px 8px; text-align: left; }
  td { overflow-wrap: anywhere; }
</style>
