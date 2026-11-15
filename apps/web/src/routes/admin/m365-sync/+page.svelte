<script lang="ts">
  let { data, form } = $props();
  const overview = $derived(data.overview);
  const toggle = $derived(overview?.toggle);
  const status = $derived(overview?.status);
  const last = $derived(status?.lastRound ?? null);

  const ACTIONS: Record<string, [string, string]> = {
    create: ['Created account and mailbox', 'Would create account and mailbox'],
    adopt: ['Linked existing account', 'Would link existing account'],
    adopt_shared: ['Linked existing shared mailbox', 'Would link existing shared mailbox'],
    create_shared: ['Created shared mailbox', 'Would create shared mailbox'],
    update_address: ['Updated address', 'Would update address'],
    update_name: ['Updated name', 'Would update name'],
    pause: ['Paused account', 'Would pause account'],
    resume: ['Resumed account', 'Would resume account'],
    left_source_kept: ['No longer a shared mailbox in Microsoft 365; kept active', 'No longer a shared mailbox in Microsoft 365; would keep active'],
    type_unknown: ['Mailbox type not readable; left as is', 'Mailbox type not readable; would leave as is'],
    wait_for_mailbox: ['Waiting for its Exchange mailbox; not created yet', 'Waiting for its Exchange mailbox; would not create yet'],
    conflict: ['Needs a manager', 'Needs a manager'],
  };
  const COUNT_LABELS: Array<[string, string]> = [
    ['created', 'Created'], ['adopted', 'Linked'], ['updated', 'Updated'], ['paused', 'Paused'],
    ['resumed', 'Resumed'], ['sharedFound', 'Shared found'], ['sharedCreated', 'Shared created'], ['conflicts', 'Conflicts'],
    ['unchanged', 'Unchanged'], ['ignored', 'Not in scope'], ['typeUnknown', 'Type unknown'],
  ];
  const typeUnknown = $derived(Number((last?.counts as Record<string, number> | undefined)?.typeUnknown ?? 0));

  function actionLabel(action: string, reason: string, dryRun: boolean): string {
    // The shared-group wording, as before detection existed.
    if (action === 'left_source_kept' && reason === 'not_in_shared_group') return dryRun ? 'Left Microsoft 365 group; would keep active' : 'Left Microsoft 365 group; kept active';
    const pair = ACTIONS[action];
    return pair ? pair[dryRun ? 1 : 0] : action;
  }
  function when(value: string | null | undefined): string {
    return value ? value.replace('T', ' ').slice(0, 16) + ' UTC' : 'never';
  }
  function deltaAge(value: string | null | undefined): string {
    if (!value) return 'none yet';
    const hours = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 3_600_000));
    return hours < 48 ? `${hours} h old` : `${Math.round(hours / 24)} days old`;
  }
</script>

<svelte:head><title>Microsoft 365 sync · Management · {data.appName || 'cmail'}</title></svelte:head>

<section class="sync-page" aria-labelledby="sync-heading">
  <header class="page-heading">
    <p class="eyebrow">Identity &amp; organisation</p>
    <h1 id="sync-heading">Microsoft 365 sync</h1>
    <p>Keep cmail accounts in step with your Microsoft 365 users. The sync only reads from Microsoft. It creates pending accounts and mailboxes for licensed users, can create shared mailboxes (from a group, or from Exchange's mailbox type), and pauses accounts that are disabled, unlicensed or removed. It never deletes mail or mailboxes and never touches managers.</p>
  </header>

  {#if form?.error}<div class="notice notice-error" role="alert">{form.error}</div>{/if}
  {#if form?.success}<div class="notice notice-success" role="status">{form.success}</div>{/if}

  {#if !overview || !toggle}
    <p class="muted">Not available in this environment.</p>
  {:else}
    {#if !overview.installed}
      <div class="notice notice-error" role="alert">Database migration 0022 has not been applied. Run <code>pnpm db:migrate</code> first.</div>
    {/if}
    {#if overview.config.state === 'not_configured'}
      <div class="notice notice-warning" role="status">
        <strong>Not configured.</strong> The email Worker needs these settings before the sync can run:
        <ul>{#each overview.config.problems as problem}<li>{problem}</li>{/each}</ul>
        See the setup steps in the Microsoft 365 sync guide.
      </div>
    {:else if overview.config.state === 'unknown'}
      <p class="muted">The email Worker could not be asked about its settings. If they are missing, the next run shows "not configured" here and changes nothing.</p>
    {/if}

    <section class="card switch-card" aria-labelledby="switch-heading">
      <div class="switch-head">
        <div>
          <h2 id="switch-heading">Sync</h2>
          <p class="muted">Off means the scheduled job does nothing.</p>
        </div>
        <span class="state-badge" class:on={toggle.enabled}>{toggle.enabled ? 'On' : 'Off'}</span>
      </div>
      <div class="switch-row">
        <form method="POST">
          <input type="hidden" name="action" value={toggle.enabled ? 'disable' : 'enable'} />
          <button type="submit" class="btn {toggle.enabled ? 'btn-outline-danger' : 'btn-primary'}"
            disabled={!toggle.enabled && (!overview.installed || overview.config.state === 'not_configured')}>
            {toggle.enabled ? 'Turn sync off' : 'Turn sync on'}
          </button>
        </form>
        <form method="POST">
          <input type="hidden" name="action" value={toggle.dryRun ? 'dry_run_off' : 'dry_run_on'} />
          <button type="submit" class="btn">{toggle.dryRun ? 'Turn dry run off (apply changes)' : 'Turn dry run on (report only)'}</button>
        </form>
        <form method="POST">
          <input type="hidden" name="action" value="sync_now" />
          <button type="submit" class="btn" disabled={!toggle.enabled}>Sync now</button>
        </form>
      </div>
      <p class="muted">Dry run is <strong>{toggle.dryRun ? 'on' : 'off'}</strong>. {toggle.dryRun ? 'Runs only report what they would change.' : 'Runs apply changes and audit each one.'} Sync now asks for a full reconciliation on the next run (within 15 minutes).</p>
    </section>

    {#if overview.unreadableLinked > 0 && status?.sharedDetection === true}
      <div class="notice notice-error" role="alert">
        <strong>Mailbox type unreadable.</strong> For {overview.unreadableLinked} linked {overview.unreadableLinked === 1 ? 'account or shared mailbox' : 'accounts or shared mailboxes'}, Exchange's mailbox type could not be read in 3 or more full reconciliations in a row. The sync leaves {overview.unreadableLinked === 1 ? 'it' : 'them'} unchanged (no pause, no update) until it can be read. Check the Entra app's <code>MailboxSettings.Read</code> permission and admin consent, and any Exchange RBAC for Applications scope. The Audit log has a <code>m365_sync.type_unreadable</code> row for each.
      </div>
    {/if}

    {#if status?.round?.phase === 'held' && status.round.brake}
      <section class="card held-card" aria-labelledby="held-heading">
        <h2 id="held-heading">Large change held for approval</h2>
        <p>
          {#if status.round.brake.reason === 'empty_result'}
            Microsoft 365 returned no users at all while {status.round.brake.linked} people are linked. Nothing was changed. This usually means a wrong tenant, a removed permission or an outage, not that everyone left.
          {:else}
            This run would pause {status.round.brake.pauses} of {status.round.brake.linked} linked people ({status.round.brake.percent}%). Nothing has been paused yet.
          {/if}
        </p>
        {#if status.round.heldPauses.length}
          <div class="table-wrap">
            <table>
              <thead><tr><th>Would pause</th><th>Reason</th></tr></thead>
              <tbody>
                {#each status.round.heldPauses as item}
                  <tr><td>{item.address || '—'}</td><td><code>{item.reason}</code></td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        <div class="switch-row">
          {#if status.round.brake.reason !== 'empty_result'}
            <form method="POST">
              <input type="hidden" name="action" value="approve_round" />
              <input type="hidden" name="round_id" value={status.round.id} />
              <button type="submit" class="btn btn-danger">Approve large change</button>
            </form>
          {/if}
          <form method="POST">
            <input type="hidden" name="action" value="sync_now" />
            <button type="submit" class="btn">Discard and sync again</button>
          </form>
        </div>
        <p class="muted">Fix the cause in Microsoft 365 first if this is not expected. Discard starts a fresh full reconciliation on the next run.</p>
      </section>
    {/if}

    {#if status}
      <section class="card" aria-labelledby="status-heading">
        <h2 id="status-heading">Status</h2>
        <dl class="facts">
          <div><dt>Last check</dt><dd>{when(status.lastTickAt)}</dd></div>
          <div><dt>Result</dt><dd>{status.lastResult ?? 'not run yet'}{status.lastError ? ` (${status.lastError.code}, ${when(status.lastError.at)})` : ''}</dd></div>
          {#if status.backoffUntil}<div><dt>Waiting until</dt><dd>{when(status.backoffUntil)}</dd></div>{/if}
          <div><dt>Last full reconciliation</dt><dd>{when(status.lastReconcileAt)}{status.lastReconcileMode === 'dry_run' ? ' (dry run)' : ''}</dd></div>
          <div><dt>Delta link</dt><dd>{deltaAge(status.deltaLinkAt)}</dd></div>
          <div><dt>Linked</dt><dd>{overview.linkedPeople} {overview.linkedPeople === 1 ? 'person' : 'people'}, {overview.linkedShared} shared {overview.linkedShared === 1 ? 'mailbox' : 'mailboxes'}</dd></div>
          <div><dt>Shared mailbox detection</dt><dd>{status.sharedDetection === true ? 'On (Exchange mailbox type)' : status.sharedDetection === false ? 'Off' : 'not run yet'}</dd></div>
          {#if status.round}<div><dt>In progress</dt><dd>{status.round.kind === 'reconcile' ? 'Full reconciliation' : 'Delta'}{status.round.mode === 'dry_run' ? ' (dry run)' : ''}, started {when(status.round.startedAt)}</dd></div>{/if}
        </dl>
      </section>

      {#if last}
        <section class="card" aria-labelledby="report-heading">
          <h2 id="report-heading">Last run: {last.kind === 'reconcile' ? 'full reconciliation' : 'delta'}{last.mode === 'dry_run' ? ', dry run' : ''}</h2>
          <p class="muted">Finished {when(last.finishedAt)}.{#if last.brake} {last.mode === 'dry_run' ? 'Live, this run would have been held for approval' : 'This run was held and then approved'} ({last.brake.reason === 'empty_result' ? 'no users returned' : `${last.brake.pauses} of ${last.brake.linked} people paused`}).{/if}</p>
          {#if typeUnknown > 0}
            <div class="notice notice-warning" role="status">
              The Exchange mailbox type of {typeUnknown} {typeUnknown === 1 ? 'object' : 'objects'} could not be read, so {typeUnknown === 1 ? 'it was' : 'they were'} left exactly as before and will be checked again. If this covers everyone, the Entra app is missing the <code>MailboxSettings.Read</code> application permission or its admin consent.
            </div>
          {/if}
          <ul class="counts">
            {#each COUNT_LABELS as [key, label]}
              <li><span>{label}</span><strong>{last.counts[key as keyof typeof last.counts] ?? 0}</strong></li>
            {/each}
          </ul>
          {#if last.report.length}
            <div class="table-wrap">
              <table>
                <thead><tr><th>Change</th><th>Microsoft 365 address</th><th>Reason</th></tr></thead>
                <tbody>
                  {#each last.report as item}
                    <tr><td>{actionLabel(item.action, item.reason, last.mode === 'dry_run')}</td><td>{item.address || '—'}</td><td><code>{item.reason}</code></td></tr>
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
