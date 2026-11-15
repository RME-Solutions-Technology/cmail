<script lang="ts">
  import { onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import Icon from '#lib/ui/Icon.svelte';
  import { browserSupportsPasskeys, registerPasskey, suggestDeviceName } from '#lib/passkey-browser.js';

  let { data, form: rawForm } = $props();
  const form = $derived(rawForm as { error?: string; success?: string } | null);

  let supported = $state(true);
  let deviceName = $state('');
  let busy = $state(false);
  let message = $state('');
  let messageIsError = $state(false);

  onMount(() => {
    supported = browserSupportsPasskeys();
    deviceName = suggestDeviceName();
  });

  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    message = 'Follow the prompt on your device...';
    messageIsError = false;
    try {
      await registerPasskey(deviceName.trim());
      message = 'Passkey added.';
      await invalidateAll();
    } catch (error) {
      message = error instanceof Error ? error.message : 'Could not add the passkey. Try again.';
      messageIsError = true;
    } finally {
      busy = false;
    }
  }

  function when(value: string | null): string {
    return value ? value.replace('T', ' ').slice(0, 16) + ' UTC' : 'Never';
  }
</script>

<svelte:head><title>Passkeys · {data.appName || 'cmail'}</title></svelte:head>

<section class="passkeys-page nb-quiet" aria-labelledby="passkeys-heading">
  <header class="page-header">
    <p class="eyebrow">Mail settings</p>
    <h1 id="passkeys-heading">Passkeys</h1>
    <p>A passkey lets you sign in when the normal sign-in is unavailable, for example during a Microsoft outage. It lives on your phone, computer or security key and is unlocked with your fingerprint, face or PIN.</p>
  </header>

  {#if form?.error}<div class="notice notice-error" role="alert">{form.error}</div>{/if}
  {#if form?.success}<div class="notice notice-success" role="status">{form.success}</div>{/if}

  <section class="card" aria-labelledby="add-heading">
    <h2 id="add-heading">Add a passkey</h2>
    {#if !supported}
      <p class="muted">This browser can't create passkeys. Try another browser or device.</p>
    {:else if !data.canAdd}
      <p class="muted">{data.addBlockedReason}</p>
    {:else}
      <form class="add-form" onsubmit={add}>
        <div class="field">
          <label for="passkey-name">Name</label>
          <input id="passkey-name" type="text" maxlength="64" required bind:value={deviceName} autocomplete="off" />
        </div>
        <button type="submit" class="btn btn-primary" disabled={busy || !deviceName.trim()}>
          <Icon name="key" size={15} /> Add passkey
        </button>
      </form>
      <p class="muted">For your safety, adding a passkey works for {data.freshMinutes} minutes after you sign in. You and your managers are emailed when one is added or removed.</p>
    {/if}
    {#if message}<p class:error-text={messageIsError} class="status-text" role="status" aria-live="polite">{message}</p>{/if}
  </section>

  <section class="card" aria-labelledby="list-heading">
    <h2 id="list-heading">Your passkeys</h2>
    {#if data.passkeys.length === 0}
      <p class="muted">You have no passkeys yet.</p>
    {:else}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Added</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {#each data.passkeys as passkey (passkey.id)}
              <tr>
                <td>{passkey.deviceName}{#if passkey.synced}<span class="tag">Synced</span>{/if}</td>
                <td>{when(passkey.createdAt)}</td>
                <td>{when(passkey.lastUsedAt)}</td>
                <td class="actions">
                  {#if data.canRemove}
                    <form method="POST" action="?/remove">
                      <input type="hidden" name="credential_id" value={passkey.id} />
                      <button type="submit" class="btn btn-outline-danger">Remove</button>
                    </form>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section class="card" aria-labelledby="use-heading">
    <h2 id="use-heading">When you need it</h2>
    <p class="muted">Open <code>{data.passkeySignInUrl}</code> and choose <strong>Use a passkey</strong>. Bookmark it now. If you lose all your passkeys, a manager can remove them and you add new ones the next time you can sign in normally.</p>
  </section>
</section>

<style>
  .passkeys-page { display: grid; gap: 24px; max-width: 860px; margin: 0 auto; }
  .page-header h1 { margin: 2px 0 6px; font-size: var(--fs-title-2); font-weight: 600; }
  .page-header > p:last-child { margin: 0; color: var(--text-muted); font-size: 13px; max-width: 720px; }
  .eyebrow { margin: 0; color: var(--text-muted); font-size: 13px; }
  .card { display: grid; gap: 10px; padding: 0; border: 0; background: none; box-shadow: none; }
  h2 { margin: 0; font-size: var(--fs-subtitle); font-weight: 600; }
  .muted { margin: 0; color: var(--text-muted); font-size: 13px; }
  .add-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 16px; }
  .field { display: flex; flex-direction: column; min-width: 220px; }
  .field label { color: var(--text-muted); font-size: 13px; }
  .status-text { margin: 0; font-size: 13px; }
  .error-text { color: var(--danger); }
  .notice { padding: 8px 12px; border-left: 3px solid; }
  .notice-error { color: var(--danger); background: var(--danger-soft); }
  .notice-success { color: var(--success); background: var(--success-soft); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 8px; text-align: left; }
  td { overflow-wrap: anywhere; }
  .actions { text-align: right; }
  .tag { margin-left: 8px; padding: 1px 8px; border-radius: var(--radius-pill); background: var(--bg-subtle); color: var(--text-muted); font-size: 11px; }
  code { overflow-wrap: anywhere; }
  @media (max-width: 600px) {
    .add-form { flex-direction: column; align-items: stretch; }
    .field { min-width: 0; }
  }
</style>
