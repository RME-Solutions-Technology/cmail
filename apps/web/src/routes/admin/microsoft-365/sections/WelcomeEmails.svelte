<script lang="ts">
  let { data, form } = $props();
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
</script>

<section class="m365-section" aria-labelledby="welcome-title">
  <header class="section-heading">
    <h2 id="welcome-title">Welcome emails</h2>
    <p>Emails each person the directory sync creates (or links while still pending) once, with first sign-in steps. Never shared mailboxes, never people who have signed in. Off by default.</p>
  </header>

  {#if form?.error}<div class="notice notice-error" role="alert">{form.error}</div>{/if}
  {#if form?.success}<div class="notice notice-success" role="status">{form.success}</div>{/if}

  {#if !welcome}
    <p class="muted">Not available in this environment.</p>
  {:else}
    <section class="card switch-card" aria-labelledby="sync-welcome-heading">
      <div class="switch-head">
        <div>
          <h3 id="sync-welcome-heading">Sending</h3>
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
      <form method="POST" action="?/sync#welcome-emails">
        <input type="hidden" name="action" value="welcome_refresh" />
        <button type="submit" class="btn btn-sm">Check sending and save organisation details</button>
      </form>
      <p class="muted">Sent from <strong>{welcome.sender.fromEmail || 'no address'}</strong>. It must be on {welcome.sender.mailDomain || 'MAIL_DOMAIN'}, and that domain must be onboarded to Cloudflare Email Sending so the message passes DMARC (Cloudflare's DKIM signature matches the From domain). Otherwise Exchange may junk or reject it.</p>

      {#if welcome.installed}
        <div class="recipients" role="group" aria-labelledby="sync-welcome-recipients-heading">
          <h4 id="sync-welcome-recipients-heading">Who would be emailed: {welcome.toggle.enabled && welcome.recipients.auto !== welcome.recipients.total ? `${welcome.recipients.auto} now, ${welcome.recipients.total - welcome.recipients.auto} more by Send` : `${welcome.recipients.total} ${welcome.recipients.total === 1 ? 'person' : 'people'}`}</h4>
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
          <form method="POST" action="?/sync#welcome-emails" class="test-form">
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
        <form method="POST" action="?/sync#welcome-emails">
          <input type="hidden" name="action" value="welcome_disable" />
          <button type="submit" class="btn btn-outline-danger">Turn welcome emails off</button>
        </form>
        <p class="muted">Turning off cancels emails not sent yet. Emails already sent stay sent.</p>
      {:else if welcome.canSend}
        <details class="confirm">
          <summary class="btn btn-primary">Turn welcome emails on…</summary>
          <form method="POST" action="?/sync#welcome-emails" class="confirm-body">
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

        <form method="POST" action="?/sync#welcome-emails" class="note-form">
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
                        <form method="POST" action="?/sync#welcome-emails">
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
</section>

<style>
  .m365-section { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; scroll-margin-top: 16px; }
  .section-heading h2 { margin: 0 0 6px; font-size: var(--fs-title-3, var(--fs-subtitle)); font-weight: 600; }
  .section-heading p { max-width: 760px; margin: 0; color: var(--text-muted); font-size: var(--fs-body); font-weight: 400; }
  h3 { margin: 0 0 4px; font-size: var(--fs-subtitle); font-weight: 600; }
  .muted { margin: 0; color: var(--text-muted); font-size: 13px; }
  .notice { overflow-wrap: anywhere; padding: 8px 12px; border: 0; border-left: 3px solid; border-radius: 0; }
  .notice ul { margin: 6px 0; padding-left: 18px; }
  .notice-error { color: var(--danger); background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 28%, var(--border)); }
  .notice-success { color: var(--success); background: var(--success-soft); border-color: color-mix(in srgb, var(--success) 28%, var(--border)); }
  .notice-warning { color: var(--text); background: var(--bg-subtle); border-color: var(--border); }
  .card { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 0 0 8px; border: 0; border-radius: 0; background: none; }
  .switch-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  .state-badge { flex: 0 0 auto; padding: 3px 10px; border-radius: var(--radius-pill); background: var(--bg-subtle); color: var(--text-muted); font-size: 12px; font-weight: 650; }
  .state-badge.on { background: var(--success-soft); color: var(--success); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { padding: 6px 8px; text-align: left; }
  td { overflow-wrap: anywhere; }
  .confirm summary { display: inline-block; cursor: pointer; list-style: none; }
  .confirm summary::-webkit-details-marker { display: none; }
  .confirm-body { display: grid; gap: 10px; margin-top: 10px; }
  fieldset { min-width: 0; display: grid; gap: 6px; margin: 0; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; }
  legend { padding: 0 4px; font-weight: 600; }
  .recipients { display: grid; gap: 8px; }
  .recipients h4 { margin: 0; font-size: 15px; font-weight: 600; }
  .recipient-list { margin: 8px 0 0; padding-left: 20px; max-height: 320px; overflow: auto; font-size: 13px; }
  .test-form { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
  .note-form { display: grid; gap: 6px; max-width: 640px; }
  .note-form label { font-size: 13px; font-weight: 600; }
  .note-form textarea { width: 100%; font: inherit; font-size: 13px; }
  .note-form .btn { justify-self: start; }
  .preview { margin: 8px 0 0; padding: 10px 12px; max-width: 640px; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg-subtle); font-size: 12.5px; }
</style>
