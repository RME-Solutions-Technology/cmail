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
  const welcome = $derived(data.welcome);
  let welcomeScope = $state('new_only');
  const WELCOME_STATUS: Record<string, string> = {
    not_sent: 'Not sent', queued: 'Waiting to send', sending: 'Sending', sent: 'Sent', failed: 'Failed', skipped: 'Skipped',
  };
  const WELCOME_RESULT: Record<string, string> = {
    ok: 'ok', dry_run: 'dry run (nothing sent)', not_configured: 'cannot send', rate_limited: 'hourly limit reached',
    paused: 'stopped by Cloudflare Email Sending', error: 'error',
  };
  function at(value: number | null | undefined): string {
    return value ? new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
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

    {#if welcome}
      <section class="card switch-card" aria-labelledby="welcome-heading">
        <div class="switch-head">
          <div>
            <h2 id="welcome-heading">Welcome emails</h2>
            <p class="muted">Emails each person the sync creates (or links while still pending) once, with first sign-in steps. Never shared mailboxes, never people who have signed in. Off by default.</p>
          </div>
          <span class="state-badge" class:on={welcome.toggle.enabled}>{welcome.toggle.enabled ? 'On' : 'Off'}</span>
        </div>

        {#if welcome.problemText.length}
          <div class="notice notice-warning" role="status">
            <strong>Cannot send:</strong>
            <ul>{#each welcome.problemText as problem}<li>{problem}</li>{/each}</ul>
            {#if !welcome.toggle.enabled}The switch stays off until this is fixed.{/if}
          </div>
        {/if}

        {#if welcome.senderRefused}
          <div class="notice notice-error" role="alert">
            <strong>Sending is not set up.</strong> Cloudflare Email Sending refused the From address on the last run (<code>{welcome.senderRefused}</code>). Onboard <strong>{welcome.sender.mailDomain || 'MAIL_DOMAIN'}</strong> in Cloudflare Email Sending (it adds the DKIM and DMARC records). Waiting emails are retried every hour.
          </div>
        {/if}
        {#if welcome.profileStale && welcome.toggle.enabled}
          <div class="notice notice-warning" role="status">
            The organisation details or sign-in settings changed since they were last saved for the email Worker, which still uses the old ones. Save them to use the new ones.
          </div>
        {/if}
        <form method="POST">
          <input type="hidden" name="action" value="welcome_refresh" />
          <button type="submit" class="btn btn-sm">Check sending and save organisation details</button>
        </form>
        <p class="muted">Sent from <strong>{welcome.sender.fromEmail || 'no address'}</strong>. It must be on {welcome.sender.mailDomain || 'MAIL_DOMAIN'}, and that domain must be onboarded to Cloudflare Email Sending so the message passes DMARC (Cloudflare's DKIM signature matches the From domain). Otherwise Exchange may junk or reject it.</p>

        {#if welcome.installed}
          <div class="recipients" aria-labelledby="welcome-recipients-heading">
            <h3 id="welcome-recipients-heading">Who would be emailed: {welcome.toggle.enabled && welcome.recipients.auto !== welcome.recipients.total ? `${welcome.recipients.auto} now, ${welcome.recipients.total - welcome.recipients.auto} more by Send` : `${welcome.recipients.total} ${welcome.recipients.total === 1 ? 'person' : 'people'}`}</h3>
            <p class="muted">
              Licensed, enabled people the sync created, who have not been sent a welcome email. Shared mailboxes, unlicensed and disabled accounts are never listed or emailed. Each name below is the Microsoft sign-in name (UPN) the email tells them to use.
              {#if welcome.toggle.enabled}{#if welcome.recipients.total > welcome.recipients.auto}Only the {welcome.recipients.auto} created since the switch went on are sent automatically; the other {welcome.recipients.total - welcome.recipients.auto} are listed too and go only when you press Send on them.{:else}All of them are sent automatically.{/if}{:else}Nothing has been sent. The switch below decides who is emailed.{/if}
            </p>
            {#if welcome.recipients.people.length}
              <details open={welcome.recipients.total <= 25}>
                <summary>Show the list</summary>
                <ul class="recipient-list">
                  {#each welcome.recipients.people as person (person.userId)}
                    <li>{person.displayName ? `${person.displayName} · ` : ''}{person.signInName}{person.signInName !== person.email ? ` (mailbox ${person.email})` : ''}</li>
                  {/each}
                </ul>
                {#if welcome.recipients.total > welcome.recipients.people.length}<p class="muted">Showing the first {welcome.recipients.people.length} of {welcome.recipients.total}.</p>{/if}
              </details>
            {:else}
              <p class="muted">No one is waiting.</p>
            {/if}
            <form method="POST" class="test-form">
              <input type="hidden" name="action" value="welcome_test" />
              <button type="submit" class="btn">Send a test to me</button>
              <span class="muted">Sends this email to your own address only, marked [Test]. Nothing is recorded or turned on. About 5 an hour.</span>
            </form>
          </div>
        {/if}

        {#if welcome.toggle.enabled}
          <p class="muted">
            {welcome.toggle.since === '1970-01-01 00:00:00' ? 'Including people who were already waiting when it was turned on.' : `For people created from ${welcome.toggle.since} UTC on.`}
            {#if !welcome.syncEnabled}Nothing is sent while the sync is off.{:else if welcome.syncDryRun}The sync is in dry run, so nothing is sent; the list below shows who would be emailed.{/if}
          </p>
          <form method="POST">
            <input type="hidden" name="action" value="welcome_disable" />
            <button type="submit" class="btn btn-outline-danger">Turn welcome emails off</button>
          </form>
          <p class="muted">Turning off cancels emails not sent yet. Emails already sent stay sent.</p>
        {:else if welcome.canSend}
          <details class="confirm">
            <summary class="btn btn-primary">Turn welcome emails on…</summary>
            <form method="POST" class="confirm-body">
              <input type="hidden" name="action" value="welcome_enable" />
              <input type="hidden" name="expected" value={welcome.waitingNow} />
              <div class="notice notice-warning" role="alert">
                <strong>Warning: this sends real email.</strong>
                Right now <strong>{welcome.waitingNow}</strong> {welcome.waitingNow === 1 ? 'person was' : 'people were'} created by the sync, {welcome.waitingNow === 1 ? 'has' : 'have'} never signed in and {welcome.waitingNow === 1 ? 'was' : 'were'} never sent a welcome email.
                Emails come from {welcome.preview?.from ?? 'the system address'} and go to each person's work address (with Exchange as primary, their Exchange inbox). Sending is rate-limited (50 an hour unless the Worker sets <code>M365_WELCOME_MAX_PER_HOUR</code>).
              </div>
              <fieldset>
                <legend>Who should be emailed?</legend>
                <label><input type="radio" name="scope" value="new_only" bind:group={welcomeScope} /> Only people created from now on</label>
                <label><input type="radio" name="scope" value="include_waiting" bind:group={welcomeScope} disabled={welcome.waitingNow === 0} /> Also the {welcome.waitingNow} {welcome.waitingNow === 1 ? 'person' : 'people'} already waiting</label>
              </fieldset>
              <button type="submit" class="btn btn-primary">{welcomeScope === 'include_waiting' ? `Turn on and email ${welcome.waitingNow} now` : 'Turn on for new people only'}</button>
            </form>
          </details>
          <p class="muted">Turning on also asks the email Worker whether it can send.</p>
          {#if !welcome.syncEnabled || welcome.syncDryRun}<p class="muted">While the sync is off or in dry run, nothing is sent. In dry run the list shows who would be emailed.</p>{/if}
        {:else}
          <button type="button" class="btn" disabled>Turn welcome emails on</button>
        {/if}

        {#if welcome.installed}
          <ul class="counts" aria-label="Welcome email counts">
            <li><span>Sent</span><strong>{welcome.counts.sent}</strong></li>
            <li><span>Waiting to send</span><strong>{welcome.counts.queued}</strong></li>
            <li><span>Failed</span><strong>{welcome.counts.failed}</strong></li>
            <li><span>Skipped</span><strong>{welcome.counts.skipped}</strong></li>
            <li><span>Not sent (never queued)</span><strong>{welcome.counts.notSent}</strong></li>
          </ul>
          {#if welcome.state.lastTickAt}
            <p class="muted">Last run {at(welcome.state.lastTickAt)}: {WELCOME_RESULT[welcome.state.lastResult ?? ''] ?? 'not run yet'}{welcome.state.lastProblem ? ` (${welcome.state.lastProblem})` : ''}.</p>
          {/if}
          {#if welcome.toggle.enabled && welcome.syncDryRun && welcome.state.dryRun}
            <div class="notice notice-warning" role="status">
              Dry run ({at(welcome.state.dryRun.at)}): {welcome.state.dryRun.count} {welcome.state.dryRun.count === 1 ? 'person' : 'people'} would be emailed now.
              {#if welcome.state.dryRun.addresses.length}<ul>{#each welcome.state.dryRun.addresses as address}<li>{address}</li>{/each}</ul>{/if}
            </div>
          {/if}

          <form method="POST" class="note-form">
            <input type="hidden" name="action" value="welcome_note" />
            <label for="welcome-note">Standby sentence (optional)</label>
            <textarea id="welcome-note" name="note" rows="2" maxlength="300" aria-describedby="welcome-note-help"
              placeholder="This is our standby mailbox. Keep using Outlook as usual; you only need it if Microsoft 365 email is down.">{welcome.toggle.note}</textarea>
            <p id="welcome-note-help" class="muted">Added after the first paragraph. Plain text, one sentence or two, up to 300 characters. Leave empty to leave it out.</p>
            <button type="submit" class="btn">Save sentence</button>
          </form>

          {#if welcome.preview}
            <details>
              <summary>Preview the email</summary>
              <p class="muted">From {welcome.preview.from}. Subject: {welcome.preview.subject}. {welcome.passkeys ? 'Passkey sign-in is on, so step 4 is included.' : 'Passkey sign-in is off, so there is no passkey step.'} {welcome.standby ? 'A standby switch is on, so it says why the account exists.' : 'No standby switch is on, so it uses neutral wording.'}</p>
              <pre class="preview">{welcome.preview.text}</pre>
            </details>
          {/if}

          {#if welcome.people.length}
            <div class="table-wrap">
              <table>
                <caption class="sr-only">Welcome emails by person</caption>
                <thead><tr><th>Person</th><th>Status</th><th>Attempts</th><th>Last attempt</th><th>Error</th><th><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {#each welcome.people as person}
                    <tr>
                      <td>{person.displayName ? `${person.displayName} · ` : ''}{person.signInName}{person.signInName !== person.email ? ` (mailbox ${person.email})` : ''}</td>
                      <td>{WELCOME_STATUS[person.status] ?? person.status}{person.sentAt ? ` ${at(person.sentAt)}` : ''}</td>
                      <td>{person.attempts}</td>
                      <td>{at(person.lastAttemptAt)}</td>
                      <td>{#if person.lastError}<code>{person.lastError}</code>{/if}</td>
                      <td>
                        {#if person.canResend && welcome.toggle.enabled && welcome.canSend}
                          <form method="POST">
                            <input type="hidden" name="action" value="welcome_resend" />
                            <input type="hidden" name="user_id" value={person.userId} />
                            <button type="submit" class="btn btn-sm" aria-label="{person.status === 'not_sent' ? 'Send' : 'Resend'} welcome email to {person.email}">{person.status === 'not_sent' ? 'Send' : 'Resend'}</button>
                          </form>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        {/if}
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
  .confirm summary { display: inline-block; cursor: pointer; list-style: none; }
  .confirm summary::-webkit-details-marker { display: none; }
  .confirm-body { display: grid; gap: 10px; margin-top: 10px; }
  fieldset { display: grid; gap: 6px; margin: 0; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; }
  legend { padding: 0 4px; font-weight: 600; }
  .recipients { display: grid; gap: 8px; }
  .recipients h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .recipient-list { margin: 8px 0 0; padding-left: 20px; max-height: 320px; overflow: auto; font-size: 13px; }
  .test-form { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
  .note-form { display: grid; gap: 6px; max-width: 640px; }
  .note-form label { font-size: 13px; font-weight: 600; }
  .note-form textarea { width: 100%; font: inherit; font-size: 13px; }
  .note-form .btn { justify-self: start; }
  .preview { margin: 8px 0 0; padding: 10px 12px; max-width: 640px; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg-subtle); font-size: 12.5px; }
</style>
