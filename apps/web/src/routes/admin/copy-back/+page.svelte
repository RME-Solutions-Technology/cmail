<script lang="ts">
  let { data, form } = $props();
  const overview = $derived(data.overview);
  const toggle = $derived(overview?.toggle);
  const job = $derived(overview?.job ?? null);
  const dry = $derived(overview?.lastDryRun ?? null);

  const FOLDER_LABELS: Record<string, string> = { inbox: 'Inbox', archive: 'Archive', sent: 'Sent' };
  const REASONS: Record<string, string> = {
    too_large: 'Too large for one request (over 3 MB)',
    already_in_exchange: 'Already in Exchange',
    body_missing: 'Body missing in storage',
    attachment_missing: 'Attachment missing in storage',
    message_gone: 'Deleted in cmail',
    folder_not_in_scope: 'Moved out of the chosen folders',
    bad_message: 'Unreadable message record',
    access_denied: 'Access denied (mailbox outside the app scope?)',
    mailbox_not_found: 'No Exchange mailbox',
    rejected: 'Rejected by Exchange',
    bad_response: 'Unexpected answer from Microsoft',
  };

  function when(value: string | null | undefined): string {
    return value ? value.replace('T', ' ').slice(0, 16) + ' UTC' : 'never';
  }
  /** 'YYYY-MM-DD HH:MM:SS' to a datetime-local value. */
  function local(value: string): string {
    return value.replace(' ', 'T').slice(0, 16);
  }
  function mailboxLabel(objectId: string | null): string {
    if (!objectId) return 'All linked mailboxes';
    return overview?.mailboxes.find((item) => item.objectId === objectId)?.address ?? 'One mailbox';
  }
  function folders(list: string[]): string {
    return list.map((item) => FOLDER_LABELS[item] ?? item).join(', ');
  }
  const formFrom = $derived(dry ? local(dry.params.from) : '');
  const formTo = $derived(dry ? local(dry.params.to) : '');
  const formTarget = $derived(dry?.params.target ?? '');
  const formFolders = $derived(new Set(dry?.params.folders ?? ['inbox']));
</script>

<svelte:head><title>Copy back to Exchange · Management · {data.appName || 'cmail'}</title></svelte:head>

<section class="copy-page" aria-labelledby="copy-heading">
  <header class="page-heading">
    <p class="eyebrow">Mail</p>
    <h1 id="copy-heading">Copy back to Exchange</h1>
    <p>After an Exchange Online outage, copy the mail that arrived in cmail meanwhile into each person's Exchange mailbox. Copies keep the received time, sender, recipients, attachments and read state, and carry the category "cmail standby copy". Each message is copied at most once. Nothing is deleted in cmail or in Exchange.</p>
  </header>

  {#if form?.error}<div class="notice notice-error" role="alert">{form.error}</div>{/if}
  {#if form?.success}<div class="notice notice-success" role="status">{form.success}</div>{/if}

  {#if !overview || !toggle}
    <p class="muted">Not available in this environment.</p>
  {:else}
    {#if !overview.installed}
      <div class="notice notice-error" role="alert">Database migrations 0022 and 0024 have not been applied. Run <code>pnpm db:migrate</code> first.</div>
    {/if}
    {#if overview.config.state === 'not_configured'}
      <div class="notice notice-warning" role="status">
        <strong>Not configured.</strong> The email Worker needs these settings before it can copy:
        <ul>{#each overview.config.problems as problem}<li>{problem}</li>{/each}</ul>
        See the setup steps in the copy-back guide.
      </div>
    {:else if overview.config.state === 'unknown'}
      <p class="muted">The email Worker could not be asked about its settings. If they are missing, the job shows "not_configured" and copies nothing.</p>
    {/if}

    <section class="card" aria-labelledby="switch-heading">
      <div class="switch-head">
        <div>
          <h2 id="switch-heading">Copy-back</h2>
          <p class="muted">Off means nothing is copied, and a running job waits.</p>
        </div>
        <span class="state-badge" class:on={toggle.enabled}>{toggle.enabled ? 'On' : 'Off'}</span>
      </div>
      <form method="POST">
        <input type="hidden" name="action" value={toggle.enabled ? 'disable' : 'enable'} />
        <button type="submit" class="btn {toggle.enabled ? 'btn-outline-danger' : 'btn-primary'}"
          disabled={!toggle.enabled && (!overview.installed || overview.config.state === 'not_configured')}>
          {toggle.enabled ? 'Turn copy-back off' : 'Turn copy-back on'}
        </button>
      </form>
    </section>

    <section class="card" aria-labelledby="window-heading">
      <h2 id="window-heading">What to copy</h2>
      <p class="muted">Times are UTC. Choose the outage window: from when Exchange stopped receiving to when mail flowed to Exchange again. A dry run only counts; it changes nothing.</p>
      <form method="POST" class="window-form">
        <input type="hidden" name="action" value="dry_run" />
        <label>From (UTC)<input type="datetime-local" name="from" required value={formFrom} /></label>
        <label>To (UTC)<input type="datetime-local" name="to" required value={formTo} /></label>
        <label>Mailbox
          <select name="target">
            <option value="" selected={formTarget === ''}>All linked mailboxes</option>
            {#each overview.mailboxes as item}
              <option value={item.objectId} selected={formTarget === item.objectId}>{item.address}</option>
            {/each}
          </select>
        </label>
        <fieldset>
          <legend>Folders</legend>
          <label class="check"><input type="checkbox" name="folders" value="inbox" checked={formFolders.has('inbox')} /> Inbox</label>
          <label class="check"><input type="checkbox" name="folders" value="archive" checked={formFolders.has('archive')} /> Archive</label>
          <label class="check"><input type="checkbox" name="folders" value="sent" checked={formFolders.has('sent')} /> Sent (only if people sent mail from cmail)</label>
        </fieldset>
        <button type="submit" class="btn" disabled={!overview.installed}>Dry run</button>
      </form>
    </section>

    {#if dry}
      <section class="card" aria-labelledby="dry-heading">
        <h2 id="dry-heading">Dry run</h2>
        <p class="muted">{when(dry.at)}: {dry.params.from} to {dry.params.to} UTC, {mailboxLabel(dry.params.target)}, {folders(dry.params.folders)}.</p>
        <ul class="counts">
          <li><span>Selected</span><strong>{dry.counts.selected}</strong></li>
          <li><span>Mailboxes</span><strong>{dry.counts.mailboxes}</strong></li>
          <li><span>To copy</span><strong>{dry.counts.toCopy}</strong></li>
          <li><span>Probably too large</span><strong>{dry.counts.likelyTooLarge}</strong></li>
          <li><span>Already copied</span><strong>{dry.counts.alreadyCopied}</strong></li>
          <li><span>Skipped before</span><strong>{dry.counts.previouslySkipped}</strong></li>
          <li><span>Failed before</span><strong>{dry.counts.previouslyFailed}</strong></li>
          <li><span>Not linked to Microsoft 365</span><strong>{dry.counts.unlinked}</strong></li>
        </ul>
        {#if dry.counts.unlinked}
          <p class="muted">Messages in mailboxes without a Microsoft 365 link are never copied. Link them with Microsoft 365 sync first.</p>
        {/if}
        <form method="POST" class="start-form">
          <input type="hidden" name="action" value="start" />
          <input type="hidden" name="from" value={local(dry.params.from)} />
          <input type="hidden" name="to" value={local(dry.params.to)} />
          <input type="hidden" name="target" value={dry.params.target ?? ''} />
          {#each dry.params.folders as folder}<input type="hidden" name="folders" value={folder} />{/each}
          <label class="check"><input type="checkbox" name="confirm" value="yes" required /> Copy these {dry.counts.toCopy} messages into Exchange</label>
          <button type="submit" class="btn btn-primary" disabled={!toggle.enabled || job?.status === 'running' || dry.counts.toCopy === 0}>Start copy</button>
        </form>
        {#if !toggle.enabled}<p class="muted">Turn copy-back on to start.</p>{/if}
      </section>
    {/if}

    {#if job}
      <section class="card" aria-labelledby="job-heading">
        <h2 id="job-heading">{job.status === 'running' ? 'Copy in progress' : job.status === 'done' ? 'Last copy: finished' : 'Last copy: cancelled'}</h2>
        <dl class="facts">
          <div><dt>Window</dt><dd>{job.params.from} to {job.params.to} UTC</dd></div>
          <div><dt>Scope</dt><dd>{mailboxLabel(job.params.target)}, {folders(job.params.folders)}</dd></div>
          <div><dt>Started</dt><dd>{when(job.createdAt)}</dd></div>
          {#if job.finishedAt}<div><dt>Ended</dt><dd>{when(job.finishedAt)}</dd></div>{/if}
          <div><dt>Last run</dt><dd>{when(job.lastTickAt)}{job.lastResult ? ` (${job.lastResult}${job.lastErrorCode ? `, ${job.lastErrorCode}` : ''})` : ''}</dd></div>
          {#if job.backoffUntil && job.status === 'running'}<div><dt>Waiting until</dt><dd>{when(job.backoffUntil)}</dd></div>{/if}
        </dl>
        <ul class="counts">
          <li><span>Selected</span><strong>{job.progress.selected}</strong></li>
          <li><span>Copied</span><strong>{job.progress.copied}</strong></li>
          <li><span>Waiting</span><strong>{job.progress.pending + job.progress.unplanned}</strong></li>
          <li><span>Failed (will retry)</span><strong>{job.progress.failed - job.progress.failedFinal}</strong></li>
          <li><span>Failed (gave up)</span><strong>{job.progress.failedFinal}</strong></li>
          <li><span>Skipped</span><strong>{job.progress.skipped}</strong></li>
        </ul>
        <div class="switch-row">
          {#if job.status === 'running'}
            <form method="POST">
              <input type="hidden" name="action" value="cancel" />
              <button type="submit" class="btn btn-outline-danger">Cancel copy</button>
            </form>
          {/if}
          {#if job.status !== 'cancelled' && job.progress.failed > 0}
            <form method="POST">
              <input type="hidden" name="action" value="retry_failed" />
              <button type="submit" class="btn">Retry failed</button>
            </form>
          {/if}
        </div>
        {#if job.problems.length}
          <div class="table-wrap">
            <table>
              <thead><tr><th>Mailbox</th><th>Result</th><th>Reason</th><th>Messages</th></tr></thead>
              <tbody>
                {#each job.problems as row}
                  <tr><td>{row.mailbox}</td><td>{row.state === 'failed' ? 'Failed' : 'Skipped'}</td><td>{REASONS[row.reason] ?? row.reason}</td><td>{row.count}</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="muted">Skipped and given-up messages stay readable in cmail. Users can forward them, or a manager can export them.</p>
        {/if}
      </section>
    {/if}
  {/if}
</section>

<style>
  .copy-page { display: grid; gap: 20px; max-width: 960px; }
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
  .switch-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  .switch-row { display: flex; flex-wrap: wrap; gap: 10px; }
  .state-badge { flex: 0 0 auto; padding: 3px 10px; border-radius: var(--radius-pill); background: var(--bg-subtle); color: var(--text-muted); font-size: 12px; font-weight: 650; }
  .state-badge.on { background: var(--success-soft); color: var(--success); }
  .window-form, .start-form { display: grid; gap: 10px; max-width: 520px; font-size: 13px; }
  .window-form label { display: grid; gap: 4px; }
  .window-form .check, .start-form .check { display: flex; gap: 8px; align-items: center; }
  fieldset { display: grid; gap: 6px; margin: 0; padding: 0; border: 0; }
  legend { padding: 0; margin-bottom: 4px; color: var(--text-muted); font-size: 12px; }
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
