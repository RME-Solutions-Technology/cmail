<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { STANDBY_REASON_TEXT } from '@cmail/shared/standby';

  let { data, form } = $props();
  const overview = $derived(data.overview);
  const view = $derived(overview?.view);
  const last = $derived(view?.last ?? null);

  const LIGHT_TEXT: Record<string, string> = {
    off: 'Off',
    green: 'Green: the last test passed',
    amber: 'Amber: needs a look',
    red: 'Red: the last test failed',
  };

  // While a test is running, refresh every 5 seconds until it has a result
  // (bounded by the timeout), so "Run test now" shows its own outcome.
  $effect(() => {
    if (!view?.running || !overview) return;
    const deadline = view.running.startedAt + overview.timeoutMinutes * 60_000 + 30_000;
    const timer = setInterval(() => {
      if (Date.now() > deadline) clearInterval(timer);
      else void invalidateAll();
    }, 5_000);
    return () => clearInterval(timer);
  });

  function when(ms: number | null | undefined): string {
    return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
  }
  function seconds(ms: number | null | undefined): string {
    if (ms == null) return '—';
    return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
  }
  function reasonText(code: string): string {
    return STANDBY_REASON_TEXT[code] ?? code;
  }
  function resultLabel(status: string): string {
    return status === 'pass' ? 'Passed' : status === 'fail' ? 'Failed' : 'Running';
  }
</script>

<svelte:head><title>Standby test · Management · {data.appName || 'cmail'}</title></svelte:head>

<section class="standby-page" aria-labelledby="standby-heading">
  <header class="page-heading">
    <p class="eyebrow">Mail</p>
    <h1 id="standby-heading">Standby test</h1>
    <p>Each person's address also works on the standby subdomain, for example <code>name@standby.your-domain</code>, and delivers to the same mailbox. Once a day cmail sends itself a test message to that address through Cloudflare and checks it arrives. A green light means mail sent to the standby address reached cmail; it does not mean your main mail domain points here.</p>
  </header>

  {#if form?.error}<div class="notice notice-error" role="alert">{form.error}</div>{/if}
  {#if form?.success}<div class="notice notice-success" role="status">{form.success}</div>{/if}

  {#if !overview || !view}
    <p class="muted">Not available in this environment.</p>
  {:else}
    {#if !overview.installed}
      <div class="notice notice-error" role="alert">Database migration 0023 has not been applied. Run <code>pnpm db:migrate</code> first.</div>
    {/if}
    {#if overview.config.state === 'not_configured'}
      <div class="notice notice-warning" role="status">
        <strong>Not configured.</strong> The email Worker needs these settings first:
        <ul>{#each overview.config.problems as problem}<li>{problem}</li>{/each}</ul>
        See the standby test guide.
      </div>
    {:else if overview.config.state === 'unknown'}
      <p class="muted">The email Worker could not be asked about its settings. If they are missing, the standby address refuses mail and no test runs.</p>
    {/if}
    {#if overview.config.state !== 'unknown' && !overview.config.canSend}
      <div class="notice notice-warning" role="status">The email Worker has no Email Sending binding (<code>EMAIL</code>), so it cannot send the test. The standby address still delivers.</div>
    {/if}

    <section class="card switch-card" aria-labelledby="switch-heading">
      <div class="switch-head">
        <div>
          <h2 id="switch-heading">Standby address</h2>
          <p class="muted">Off means mail to the standby subdomain is refused and no tests run.</p>
        </div>
        <span class="state-badge" class:on={overview.enabled}>{overview.enabled ? 'On' : 'Off'}</span>
      </div>
      <div class="switch-row">
        <form method="POST">
          <input type="hidden" name="action" value={overview.enabled ? 'disable' : 'enable'} />
          <button type="submit" class="btn {overview.enabled ? 'btn-outline-danger' : 'btn-primary'}"
            disabled={!overview.enabled && (!overview.installed || overview.config.state === 'not_configured')}>
            {overview.enabled ? 'Turn standby address off' : 'Turn standby address on'}
          </button>
        </form>
        <form method="POST">
          <input type="hidden" name="action" value="run_now" />
          <button type="submit" class="btn" disabled={!overview.enabled || Boolean(view.running)}>Run test now</button>
        </form>
      </div>
      {#if overview.config.state === 'configured'}
        <p class="muted">Standby domain <code>{overview.config.standbyDomain}</code>. Tests go to <code>{overview.config.probeAddress}</code> and fail if nothing arrives within {overview.config.timeoutMinutes} minutes.</p>
      {/if}
    </section>

    <section class="card" aria-labelledby="status-heading">
      <h2 id="status-heading">Status</h2>
      <div class="light light-{view.light}" role="status">
        <span class="dot" aria-hidden="true"></span>
        <div>
          <strong>{LIGHT_TEXT[view.light]}</strong>
          {#if view.reason}<p>{reasonText(view.reason)}{#if view.light === 'red' && last?.detail} ({last.detail}){/if}</p>{/if}
          {#if view.running}<p>A test started {when(view.running.startedAt)} is waiting for its message.</p>{/if}
        </div>
      </div>
      {#if last}
        <dl class="facts">
          <div><dt>Last result</dt><dd>{resultLabel(last.status)}, {when(last.startedAt)} ({last.kind === 'manual' ? 'run now' : 'daily'})</dd></div>
          <div><dt>Round trip</dt><dd>{seconds(last.roundTripMs)}</dd></div>
          {#if last.status === 'fail'}<div><dt>Reason</dt><dd><code>{last.reason}</code>{last.detail ? ` ${last.detail}` : ''}</dd></div>{/if}
          {#if last.status === 'pass'}
            <div><dt>Filed to</dt><dd>{last.folder ?? '—'}</dd></div>
            <div><dt>SPF / DKIM / DMARC</dt><dd>{last.spf ?? '—'} / {last.dkim ?? '—'} / {last.dmarc ?? '—'}</dd></div>
            {#if last.warnings.length}<div><dt>Notes</dt><dd>{last.warnings.map(reasonText).join(' ')}</dd></div>{/if}
          {/if}
        </dl>
      {/if}
    </section>

    <section class="card" aria-labelledby="history-heading">
      <h2 id="history-heading">Last 7 days</h2>
      {#if overview.runs.length}
        <div class="table-wrap">
          <table>
            <thead><tr><th>Started</th><th>Type</th><th>Result</th><th>Round trip</th><th>Reason</th></tr></thead>
            <tbody>
              {#each overview.runs as run (run.id)}
                <tr>
                  <td>{when(run.startedAt)}</td>
                  <td>{run.kind === 'manual' ? 'Run now' : 'Daily'}</td>
                  <td>{resultLabel(run.status)}</td>
                  <td>{seconds(run.roundTripMs)}</td>
                  <td>{#if run.reason}<code>{run.reason}</code> {run.detail}{:else if run.warnings.length}{run.warnings.join(', ')}{:else}—{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="muted">No tests in the last 7 days.</p>
      {/if}
      <p class="muted">Results are kept for 30 days. Test messages are stored in the "Standby probe (system)" mailbox, which nobody is assigned to, and removed after 7 days.</p>
    </section>
  {/if}
</section>

<style>
  .standby-page { display: grid; gap: 20px; max-width: 960px; }
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
  .light { display: flex; gap: 12px; align-items: flex-start; padding: 12px; border-left: 3px solid var(--border); background: var(--bg-subtle); }
  .light p { margin: 4px 0 0; font-size: 13px; }
  .dot { flex: 0 0 auto; width: 14px; height: 14px; margin-top: 2px; border-radius: 50%; background: var(--text-muted); }
  .light-green { border-color: var(--success); background: var(--success-soft); }
  .light-green .dot { background: var(--success); }
  .light-amber { border-color: var(--warning); background: var(--warning-soft); }
  .light-amber .dot { background: var(--warning); }
  .light-red { border-color: var(--danger); background: var(--danger-soft); }
  .light-red .dot { background: var(--danger); }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 24px; margin: 0; }
  .facts dt { color: var(--text-muted); font-size: 12px; }
  .facts dd { margin: 2px 0 0; font-size: 13px; overflow-wrap: anywhere; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { padding: 6px 8px; text-align: left; }
  td { overflow-wrap: anywhere; }
</style>
