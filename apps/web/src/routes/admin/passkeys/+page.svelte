<script lang="ts">
  let { data, form } = $props();
  const overview = $derived(data.overview);

  function when(value: string | null | undefined): string {
    return value ? value.replace('T', ' ').slice(0, 16) + ' UTC' : 'never';
  }
</script>

<svelte:head><title>Passkey sign-in · Management · {data.appName || 'cmail'}</title></svelte:head>

<section class="passkey-admin" aria-labelledby="passkey-heading">
  <header class="page-heading">
    <p class="eyebrow">Identity &amp; organisation</p>
    <h1 id="passkey-heading">Passkey sign-in</h1>
    <p>Break-glass sign-in for when Microsoft or Cloudflare Access is unavailable. People add passkeys while signed in the normal way, then sign in at <code>/auth/passkey</code> with a passkey alone. Every passkey sign-in is audited, and managers are emailed when a manager uses one.</p>
  </header>

  {#if form?.error}<div class="notice notice-error" role="alert">{form.error}</div>{/if}
  {#if form?.success}<div class="notice notice-success" role="status">{form.success}</div>{/if}

  {#if !overview}
    <p class="muted">Not available in this environment.</p>
  {:else}
    {#if !overview.installed}
      <div class="notice notice-error" role="alert">Database migration 0025 has not been applied. Run <code>pnpm db:migrate</code> first.</div>
    {/if}
    {#if !overview.rp}
      <div class="notice notice-warning" role="status"><strong>Not configured.</strong> Set <code>APP_URL</code> to this site's https address (for example <code>https://mail.example.com</code>). Passkeys are bound to that hostname.</div>
    {/if}

    <section class="card" aria-labelledby="switch-heading">
      <div class="switch-head">
        <div>
          <h2 id="switch-heading">Passkey sign-in</h2>
          <p class="muted">Off means <code>/auth/passkey</code> answers "not found", Mail &gt; Settings &gt; Passkeys is hidden, and passkey sessions are signed out. Passkeys already added are kept.</p>
        </div>
        <span class="state-badge" class:on={overview.enabled}>{overview.enabled ? 'On' : 'Off'}</span>
      </div>
      <form method="POST">
        <input type="hidden" name="action" value={overview.enabled ? 'disable' : 'enable'} />
        <button type="submit" class="btn {overview.enabled ? 'btn-outline-danger' : 'btn-primary'}"
          disabled={!overview.enabled && (!overview.installed || !overview.rp)}>
          {overview.enabled ? 'Turn passkey sign-in off' : 'Turn passkey sign-in on'}
        </button>
      </form>
      {#if overview.rp}
        <p class="muted">Passkeys are bound to <code>{overview.rp.rpID}</code> and accepted only from <code>{overview.rp.origin}</code>.</p>
      {/if}
      {#if data.accessOn}
        <p class="muted"><strong>Cloudflare Access is on.</strong> Exclude only <code>/auth/passkey</code> from the Access application with a Bypass policy, and keep everything else behind Access. During an outage the mail pages also need to be reachable: follow the break-glass steps in the passkey guide.</p>
      {/if}
    </section>

    <section class="card" aria-labelledby="people-heading">
      <h2 id="people-heading">People with passkeys</h2>
      <p class="muted">{overview.totalPasskeys} {overview.totalPasskeys === 1 ? 'passkey' : 'passkeys'} in total. Remove someone's passkeys if a device is lost or stolen or they leave; it also signs out their passkey sessions.</p>
      {#if overview.people.length}
        <div class="table-wrap">
          <table>
            <thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Passkeys</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {#each overview.people as person (person.userId)}
                <tr>
                  <td>{person.displayName || person.email}<br /><small class="muted">{person.email}</small></td>
                  <td>{person.role}</td>
                  <td>{person.status}</td>
                  <td>{person.count}</td>
                  <td>{when(person.lastUsedAt)}</td>
                  <td>
                    <form method="POST">
                      <input type="hidden" name="action" value="remove_user" />
                      <input type="hidden" name="user_id" value={person.userId} />
                      <button type="submit" class="btn btn-outline-danger">Remove all</button>
                    </form>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="muted">Nobody has added a passkey yet.</p>
      {/if}
    </section>
  {/if}
</section>

<style>
  .passkey-admin { display: grid; gap: 20px; max-width: 960px; }
  .page-heading h1 { margin: 2px 0 6px; font-size: var(--fs-title-2); font-weight: 600; }
  .page-heading > p:last-child { max-width: 760px; color: var(--text-muted); font-size: var(--fs-body); font-weight: 400; }
  .eyebrow { margin: 0; }
  h2 { margin: 0 0 4px; font-size: var(--fs-subtitle); font-weight: 600; }
  .muted { margin: 0; color: var(--text-muted); font-size: 13px; }
  .notice { padding: 8px 12px; border: 0; border-left: 3px solid; border-radius: 0; }
  .notice-error { color: var(--danger); background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 28%, var(--border)); }
  .notice-success { color: var(--success); background: var(--success-soft); border-color: color-mix(in srgb, var(--success) 28%, var(--border)); }
  .notice-warning { color: var(--text); background: var(--bg-subtle); border-color: var(--border); }
  .card { display: grid; gap: 12px; padding: 0 0 8px; border: 0; border-radius: 0; background: none; }
  .switch-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  .state-badge { flex: 0 0 auto; padding: 3px 10px; border-radius: var(--radius-pill); background: var(--bg-subtle); color: var(--text-muted); font-size: 12px; font-weight: 650; }
  .state-badge.on { background: var(--success-soft); color: var(--success); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { padding: 6px 8px; text-align: left; }
  td { overflow-wrap: anywhere; }
  code { overflow-wrap: anywhere; }
</style>
