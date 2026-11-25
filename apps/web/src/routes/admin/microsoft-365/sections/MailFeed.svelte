<script lang="ts">
  import { EXCHANGE_MIRROR_REASON_TEXT } from '@stanchion/shared/exchange-mirror';
  import { onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import {
    D1_MAX_DATABASE_BYTES,
    GRAPH_IMPORT_ERROR_TEXT,
    GRAPH_IMPORT_MESSAGES_PER_RUN,
    GRAPH_IMPORT_PERIODS,
    formatBytes,
    formatDuration,
    formatUsd,
    graphImportProgress,
  } from '@stanchion/shared/graph-import';
  import { GRAPH_MIRROR_REASON_TEXT, STANDBY_SWITCH_SOONER_NOTE } from '@stanchion/shared/graph-mirror';

  let { data, form } = $props();
  const appName = $derived(data.appName || 'Stanchion');
  const overview = $derived(data.overview);
  const today = $derived(overview && overview.days[0]?.day === new Date(overview.now).toISOString().slice(0, 10) ? overview.days[0] : null);

  function when(ms: number | null | undefined): string {
    return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
  }
  function reasonText(code: string): string {
    return EXCHANGE_MIRROR_REASON_TEXT[code] ?? GRAPH_MIRROR_REASON_TEXT[code] ?? code;
  }
  const FOLDER_NAMES: Record<string, string> = { inbox: 'Inbox', sentitems: 'Sent Items', archive: 'Archive' };
  const graph = $derived(overview?.graph);
  const graphToday = $derived(graph?.status && graph.status.day === new Date(overview?.now ?? 0).toISOString().slice(0, 10) ? graph.status.today : null);
  let sliderStop = $state(1);
  const sliderPeriod = $derived(GRAPH_IMPORT_PERIODS[sliderStop] ?? GRAPH_IMPORT_PERIODS[1]);
  const imp = $derived(graph?.import);
  const estimate = $derived(imp?.estimate ?? null);
  const figures = $derived(imp?.figures ?? null);
  const job = $derived(imp?.job ?? null);
  const jobRunning = $derived(job?.status === 'running');
  const counting = $derived(estimate?.status === 'running' || Boolean(imp?.requestPending));
  const periodLabel = (key: string | undefined) => GRAPH_IMPORT_PERIODS.find((period) => period.key === key)?.label ?? '';
  const progress = $derived(job ? graphImportProgress(job) : null);
  const canStart = $derived(Boolean(estimate && estimate.status === 'done' && figures && !figures.blocked && !estimate.jobId && !estimate.refused && (!estimate.then || estimate.changed)));
  onMount(() => {
    // While a count or an import runs, refresh the figures every 20 seconds.
    const timer = setInterval(() => {
      if (jobRunning || counting) void invalidateAll();
    }, 20_000);
    return () => clearInterval(timer);
  });
  const ALIAS_RESULT: Record<string, string> = {
    ok: 'Imported',
    dry_run: 'Dry run (nothing written)',
    held: 'Held: nothing removed (see below)',
    error: 'Failed',
    not_configured: 'Microsoft 365 sync settings are missing',
  };
</script>

<section class="m365-section" aria-labelledby="feed-title">
  <header class="section-heading">
    <h2 id="feed-title">Mail feed</h2>
    <p>Keeps {appName} a live copy of your Exchange Online mail, so people already have their recent mail here if Exchange fails. The Graph source (recommended) reads each linked mailbox from Microsoft 365; the older journal source receives a copy of every message by email. Both are off by default and can run together: a message that arrives by both is filed once. Nothing here changes how {appName} receives its own mail.</p>
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

    {#if graph}
      <section class="card" aria-labelledby="feed-graph-heading">
        <div class="switch-head">
          <div>
            <h3 id="feed-graph-heading">Graph source (recommended)</h3>
            <p class="muted">Reads new mail from each mailbox the Microsoft 365 sync linked (people and shared mailboxes) every few minutes, with the sync's app and the Exchange role "Application Mail.Read". Copies are filed as read, with no notification and no rules. Unlike the journal source, mail from senders with a strict DMARC policy is not lost.</p>
          </div>
          <span class="state-badge" class:on={graph.enabled}>{graph.enabled ? 'On' : 'Off'}</span>
        </div>
        <div class="notice notice-warning standby-note" role="note" data-testid="standby-sooner-note">{STANDBY_SWITCH_SOONER_NOTE}</div>
        {#if !graph.installed}
          <div class="notice notice-error" role="alert">Database migration 0033 has not been applied. Run <code>pnpm db:migrate</code> first.</div>
        {/if}
        {#if graph.config.state === 'not_configured'}
          <div class="notice notice-warning" role="status">
            <strong>Not configured.</strong> The email Worker needs these settings first:
            <ul>{#each graph.config.problems as problem}<li>{problem}</li>{/each}</ul>
          </div>
        {/if}
        {#if graph.status?.permissionMissing}
          <div class="notice notice-error" role="alert">Microsoft Graph refused every mailbox. Assign "Application Mail.Read" to the app in Exchange Online (see the guide), then wait up to two hours for Exchange to pick it up.</div>
        {:else if graph.status && graph.status.denied > 0}
          <div class="notice notice-warning" role="status">{graph.status.denied} mailbox{graph.status.denied === 1 ? ' is' : 'es are'} outside the app's Exchange RBAC scope, so {graph.status.denied === 1 ? 'it is' : 'they are'} not mirrored.</div>
        {/if}
        <div class="actions">
          <form method="POST" action="?/mirror#mail-feed">
            <input type="hidden" name="action" value={graph.enabled ? 'graph_disable' : 'graph_enable'} />
            <button type="submit" class="btn {graph.enabled ? 'btn-outline-danger' : 'btn-primary'}"
              disabled={!graph.enabled && (!graph.installed || graph.config.state === 'not_configured')}>
              {graph.enabled ? 'Turn Graph source off' : 'Turn Graph source on'}
            </button>
          </form>
          {#if graph.enabled}
            <form method="POST" action="?/mirror#mail-feed">
              <input type="hidden" name="action" value="graph_run_now" />
              <button type="submit" class="btn">Run now</button>
            </form>
          {/if}
        </div>
        {#if graph.config.state === 'configured'}
          <dl class="facts">
            <div><dt>Folders</dt><dd>{graph.config.folders.map((folder: string) => FOLDER_NAMES[folder] ?? folder).join(', ')}</dd></div>
            <div><dt>First pull</dt><dd>Last {graph.config.lookbackHours} hours, at most {graph.config.initialCap} messages per folder</dd></div>
          </dl>
        {/if}
        {#if graph.status}
          <dl class="facts">
            <div><dt>Last run</dt><dd>{when(graph.status.lastRunAt)}</dd></div>
            <div><dt>Last clean run</dt><dd>{when(graph.status.lastOkAt)}</dd></div>
            <div><dt>Mailboxes covered</dt><dd>{graph.status.mailboxes}</dd></div>
            <div><dt>Filed today</dt><dd>{graphToday?.filed ?? 0} to Inbox or Archive, {graphToday?.sentFiled ?? 0} to Sent</dd></div>
            <div><dt>Already here today</dt><dd>{graphToday?.duplicates ?? 0}</dd></div>
            <div><dt>Not filed today</dt><dd>{graphToday?.skipped ?? 0} skipped, {graphToday?.capped ?? 0} older messages left out</dd></div>
            <div><dt>Last filed</dt><dd>{when(graph.status.lastFiledAt)}</dd></div>
          </dl>
          {#if graph.status.lastError}
            <p class="muted">Last error ({when(graph.status.lastErrorAt)}): <code>{graph.status.lastError}</code> {reasonText(graph.status.lastError)}</p>
          {/if}
          {#if graphToday?.skipped || graphToday?.capped}
            {#if graph.status.lastSkipReason}<p class="muted">First reason today: <code>{graph.status.lastSkipReason}</code> {reasonText(graph.status.lastSkipReason)}</p>{/if}
          {/if}
        {/if}
        {#if graph.enabled}
          <div class="import-box" role="group" aria-labelledby="feed-import-heading">
            <h4 id="feed-import-heading">Import older mail</h4>
            <p class="muted">Bring older mail from Microsoft 365 into every mirrored mailbox (people and shared, all domains). It is a finite import, not a copy that keeps growing: first a count (a dry run that writes no mail), then your confirmation, then the import in the background.</p>

            {#if job && job.status !== 'running' && job.finishedAt}
              <div class="notice notice-success" role="status">
                {job.status === 'done' ? 'Import finished' : 'Import stopped'} ({periodLabel(job.period)}, {when(job.finishedAt)}): {job.filed} filed, {job.duplicates} already here, {job.skipped} skipped{job.errors ? `, ${job.errors} folders or mailboxes could not be read` : ''}. {job.error ? (GRAPH_IMPORT_ERROR_TEXT[job.error] ?? job.error) : ''}
              </div>
            {/if}

            {#if jobRunning && job && progress}
              <h4>Importing {periodLabel(job.period)}</h4>
              <progress max="100" value={progress.percent} aria-label="Import progress">{progress.percent}%</progress>
              <dl class="facts">
                <div><dt>Mailboxes done</dt><dd>{job.mailboxesDone} of {job.mailboxesTotal}</dd></div>
                <div><dt>Messages filed</dt><dd>{job.filed} filed, {job.duplicates} already here, {job.skipped} skipped</dd></div>
                <div><dt>Remaining</dt><dd>about {progress.remaining} of about {job.estMessages} ({progress.percent}% done)</dd></div>
                <div><dt>Time left</dt><dd>{progress.remaining ? formatDuration(progress.etaHours) : 'finishing'}</dd></div>
                <div><dt>Last progress</dt><dd>{when(job.lastProgressAt)}</dd></div>
              </dl>
              {#if job.error}<p class="muted">{GRAPH_IMPORT_ERROR_TEXT[job.error] ?? job.error}</p>{/if}
              {#if job.errors}<p class="muted">{job.errors} folders or mailboxes could not be read and were left out.</p>{/if}
              <p class="muted">Runs in the background, a few hundred messages every 5 minutes, after live mail. Live mail always goes first. This figure refreshes by itself.</p>
              <form method="POST" action="?/mirror#mail-feed"><input type="hidden" name="action" value="graph_import_stop" /><button type="submit" class="btn">Stop the import</button></form>
            {:else}
              {#if counting}
                <div class="notice notice-warning" role="status">
                  {#if estimate?.status === 'running'}
                    {estimate.then ? 'Counting again to check the numbers you confirmed' : `Counting ${periodLabel(estimate.period).toLowerCase()}`}: {estimate.mailboxesDone} of {estimate.mailboxesTotal} mailboxes so far, about {estimate.messages} messages.
                  {:else}
                    Waiting for the next scheduled run (within about 5 minutes) to {imp?.requestPending === 'start' ? 'check the numbers and start' : 'start counting'}.
                  {/if}
                </div>
                <form method="POST" action="?/mirror#mail-feed"><input type="hidden" name="action" value="graph_import_stop" /><button type="submit" class="btn">Cancel</button></form>
              {:else}
                <form method="POST" action="?/mirror#mail-feed" class="import-slider">
                  <input type="hidden" name="action" value="graph_import_estimate" />
                  <label for="import-stop">How far back: <strong>{sliderPeriod.label}</strong></label>
                  <input id="import-stop" name="stop" type="range" min="0" max={GRAPH_IMPORT_PERIODS.length - 1} step="1" bind:value={sliderStop} aria-valuetext={sliderPeriod.label} />
                  <div class="slider-stops" aria-hidden="true">{#each GRAPH_IMPORT_PERIODS as period}<span>{period.label}</span>{/each}</div>
                  <button type="submit" class="btn">Estimate first (dry run)</button>
                </form>
              {/if}

              {#if estimate && estimate.status === 'done' && figures}
                <h4>Estimate: {periodLabel(estimate.period)}</h4>
                {#if estimate.changed && estimate.then}
                  <div class="notice notice-warning" role="alert">The count changed by more than 20% since you confirmed it (it was about {estimate.then.messages} messages, it is now about {estimate.messages}). Nothing was started. Review the new numbers and confirm again.</div>
                {/if}
                {#if estimate.refused}
                  <div class="notice notice-error" role="alert">Not started: {estimate.refused === 'd1_over' ? 'the database would pass its size limit' : 'the database size could not be read'}.</div>
                {/if}
                {#if estimate.jobId}<p class="muted">This estimate started an import.</p>{/if}
                <dl class="facts">
                  <div><dt>Messages</dt><dd>about {figures.messages} in {estimate.mailboxesTotal} mailboxes{estimate.errors ? ` (${estimate.errors} folders could not be counted)` : ''}</dd></div>
                  <div><dt>Size</dt><dd>about {formatBytes(figures.bytes)}{estimate.assumedSize ? ' (some sizes were assumed)' : ''}</dd></div>
                  <div><dt>Database (D1)</dt><dd>
                    {#if figures.d1UsedBytes === null}
                      size now not available; limit {formatBytes(D1_MAX_DATABASE_BYTES)}; this import adds about {formatBytes(figures.d1AddBytes)}
                    {:else}
                      {formatBytes(figures.d1UsedBytes)} used now, about {formatBytes(figures.d1AddBytes)} more, about {formatBytes(figures.d1AfterBytes ?? 0)} after = {figures.d1AfterPercent}% of the {formatBytes(figures.d1LimitBytes)} limit per database
                    {/if}
                  </dd></div>
                  <div><dt>Storage (R2)</dt><dd>about {formatBytes(figures.r2AddBytes)} added; about {formatUsd(figures.r2UsdPerMonth)} a month before the free tier, about {formatUsd(figures.r2UsdPerMonthAfterFree)} a month if nothing else uses the 10 GB free tier (R2 Standard, $0.015 per GB-month)</dd></div>
                  <div><dt>Time</dt><dd>{formatDuration(figures.hours)} ({figures.runs} runs of up to {GRAPH_IMPORT_MESSAGES_PER_RUN} messages, one every 5 minutes)</dd></div>
                  <div><dt>Counted</dt><dd>{when(estimate.finishedAt)}</dd></div>
                </dl>
                {#if figures.d1Level === 'over'}
                  <div class="notice notice-error" role="alert">This import would take the database past its size limit. It cannot start. Choose a shorter period.</div>
                {:else if figures.d1Level === 'near'}
                  <div class="notice notice-warning" role="alert">This import would bring the database near its size limit ({figures.d1AfterPercent}%). Consider a shorter period.</div>
                {:else if figures.d1Level === 'unknown'}
                  <div class="notice notice-warning" role="alert">The database size could not be read, so the limit could not be checked.{figures.blocked ? ' "All mail" cannot start; choose a shorter period.' : ''}</div>
                {/if}
                {#if imp?.mailboxes.length}
                  <details><summary>Largest mailboxes</summary>
                    <ul>{#each imp.mailboxes as box}<li>{box.address}: about {box.messages} messages, about {formatBytes(box.bytes)}</li>{/each}</ul>
                  </details>
                {/if}
                {#if canStart && !counting}
                  <div class="notice notice-warning" role="note">
                    <strong>Before you start.</strong> A big import uses storage that costs money on Cloudflare, can take hours or days, and runs in the background. You can stop it at any time. Nothing already in {appName} is changed or duplicated (mail is matched by its Message-ID). Imported mail is filed as read, with no rules and no notifications.
                  </div>
                  <form method="POST" action="?/mirror#mail-feed" class="import-confirm">
                    <input type="hidden" name="action" value="graph_import_start" />
                    <input type="hidden" name="estimateId" value={estimate.id} />
                    <input type="hidden" name="messages" value={estimate.messages} />
                    <input type="hidden" name="bytes" value={estimate.bytes} />
                    <label><input type="checkbox" name="confirmed" value="yes" required /> I have read the warning and these numbers: about {figures.messages} messages, about {formatBytes(figures.bytes)}, {formatDuration(figures.hours)}.</label>
                    <button type="submit" class="btn btn-primary">Start the import</button>
                  </form>
                {/if}
              {/if}
            {/if}
          </div>
        {/if}
      </section>
    {/if}

    <section class="card" aria-labelledby="feed-colleague-heading">
      <div class="switch-head">
        <div>
          <h3 id="feed-colleague-heading">Send colleague mail through Exchange</h3>
          <p class="muted">On: mail from {appName} to a colleague on the mail domain goes out through the outbound provider, so Exchange delivers it and it shows in Outlook; the {appName} copy comes from the mirror. Off: it goes straight into their {appName} mailbox only. Prove it with one test message first (<a href="https://github.com/RME-Solutions-Technology/stanchion/blob/main/docs/exchange-mirror.md#prove-it-with-one-message">how</a>).</p>
        </div>
        <span class="state-badge" class:on={overview.colleagueSend && overview.enabled}>{overview.colleagueSend ? (overview.enabled ? 'On' : 'On (mirror off: not in effect)') : 'Off'}</span>
      </div>
      <form method="POST" action="?/mirror#mail-feed">
        <input type="hidden" name="action" value={overview.colleagueSend ? 'colleague_send_disable' : 'colleague_send_enable'} />
        <button type="submit" class="btn {overview.colleagueSend ? 'btn-outline-danger' : 'btn-primary'}" disabled={!overview.colleagueSend && !overview.enabled}>
          {overview.colleagueSend ? 'Turn off' : 'Turn on'}
        </button>
      </form>
    </section>

    <section class="card" aria-labelledby="feed-alias-heading">
      <div class="switch-head">
        <div>
          <h3 id="feed-alias-heading">Aliases from Microsoft 365</h3>
          <p class="muted">Imports each synced person's and shared mailbox's extra addresses (proxyAddresses on your mail domain), so mirrored mail sent to an alias is filed. Needs the Microsoft 365 sync on and out of dry run. Only the Exchange mirror uses these aliases.</p>
        </div>
        <span class="state-badge" class:on={overview.aliasEnabled}>{overview.aliasEnabled ? 'On' : 'Off'}</span>
      </div>
      <form method="POST" action="?/mirror#mail-feed">
        <input type="hidden" name="action" value={overview.aliasEnabled ? 'alias_disable' : 'alias_enable'} />
        <button type="submit" class="btn {overview.aliasEnabled ? 'btn-outline-danger' : 'btn-primary'}" disabled={!overview.aliasEnabled && !overview.installed}>
          {overview.aliasEnabled ? 'Turn alias import off' : 'Turn alias import on'}
        </button>
      </form>
      {#if overview.aliasEnabled && !overview.aliasesFresh}
        <div class="notice notice-warning" role="status">Imported aliases are not being used: the last full, successful import is missing or more than 3 days old. Mirrored mail to an alias counts as unmatched until the import succeeds.</div>
      {/if}
      {#if overview.aliasState?.lastError === 'mass_removal'}
        <div class="notice notice-warning" role="status">
          The last import would remove {overview.aliasState.counts?.heldRemovals ?? 'many'} aliases at once, so it held them. Check Microsoft 365, then approve if it is right.
          <form method="POST" action="?/mirror#mail-feed"><input type="hidden" name="action" value="alias_approve_removals" /><button type="submit" class="btn">Approve alias removals</button></form>
        </div>
      {/if}
      {#if overview.aliasEnabled && (!overview.sync.enabled || overview.sync.dryRun)}
        <div class="notice notice-warning" role="status">The Microsoft 365 sync is {overview.sync.enabled ? 'in dry run' : 'off'}, so aliases are {overview.sync.enabled ? 'only counted, not written' : 'not imported'}.</div>
      {/if}
      <dl class="facts">
        <div><dt>Aliases held</dt><dd>{overview.aliasCount}</dd></div>
        <div><dt>Last import</dt><dd>{when(overview.aliasState?.lastRunAt)}{overview.aliasState?.lastResult ? `: ${ALIAS_RESULT[overview.aliasState.lastResult] ?? overview.aliasState.lastResult}` : ''}{overview.aliasState?.lastError ? ` (${overview.aliasState.lastError})` : ''}</dd></div>
        {#if overview.aliasState?.counts}
          <div><dt>Last import changes</dt><dd>{overview.aliasState.counts.added} added, {overview.aliasState.counts.moved} moved, {overview.aliasState.counts.removed} removed, {overview.aliasState.counts.conflicts} refused (address in use or claimed twice){overview.aliasState.counts.heldRemovals ? `, ${overview.aliasState.counts.heldRemovals} removals held` : ''}</dd></div>
          <div><dt>Last full successful import</dt><dd>{when(overview.aliasState.lastOkAt)}</dd></div>
        {/if}
      </dl>
    </section>

    <details class="legacy" data-testid="journal-source" open={overview.enabled}>
      <summary>Journal source (legacy, not recommended with Cloudflare Email Routing) <span class="state-badge" class:on={overview.enabled}>{overview.enabled ? 'On' : 'Off'}</span></summary>
      <section class="card" aria-labelledby="feed-switch-heading">
        <div class="switch-head">
          <div>
            <h3 id="feed-switch-heading">Journal address and checks</h3>
            <p class="muted">Journal reports carry the original sender in From, so Cloudflare Email Routing refuses reports for mail from senders whose DMARC policy is reject, and that mail never reaches {appName}. Use the Graph source instead.</p>
            <p class="muted">Off means mail to the journal address is refused like any unknown address and nothing is filed.</p>
          </div>
          <span class="state-badge" class:on={overview.enabled}>{overview.enabled ? 'On' : 'Off'}</span>
        </div>
        <form method="POST" action="?/mirror#mail-feed">
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
            <div><dt>Sent copies</dt><dd>{overview.config.mirrorSent ? `Filed for ${appName} users who sent through Exchange` : 'Off (default until a live test confirms the report headers)'}</dd></div>
          </dl>
        {/if}
      </section>

      <section class="card" aria-labelledby="feed-status-heading">
        <h3 id="feed-status-heading">Status</h3>
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
        <p class="muted">Unmatched recipients are people outside this organisation, or addresses with no active {appName} mailbox or alias. Refused reports and skipped copies are in the audit log.</p>
      </section>
    </details>
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
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 10px 24px; margin: 0; }
  .facts dt { color: var(--text-muted); font-size: 12px; }
  .facts dd { margin: 2px 0 0; font-size: 13px; overflow-wrap: anywhere; }
  .table-wrap { overflow-x: auto; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .import-box { display: grid; gap: 10px; padding-top: 8px; }
  .import-box h4 { margin: 0; font-size: 14px; font-weight: 600; }
  .import-slider { display: grid; gap: 6px; max-width: 560px; }
  .import-slider input[type='range'] { width: 100%; }
  .slider-stops { display: flex; justify-content: space-between; gap: 2px; color: var(--text-muted); font-size: 11px; }
  .import-confirm { display: grid; gap: 8px; max-width: 640px; font-size: 13px; }
  progress { width: 100%; max-width: 560px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { padding: 6px 8px; text-align: left; }
  .legacy { border-top: 1px solid var(--border); padding-top: 12px; }
  .legacy > summary { cursor: pointer; font-weight: 600; font-size: 14px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .legacy[open] > summary { margin-bottom: 12px; }
  .legacy > .card { margin-bottom: 16px; }
</style>
