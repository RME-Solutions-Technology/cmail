<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import Icon from '#lib/ui/Icon.svelte';
  import { browserSupportsPasskeys, registerPasskey, suggestDeviceName } from '#lib/passkey-browser.js';
  import { qrPath, type QrPath } from '#lib/qr.js';

  let { data, form: rawForm } = $props();
  const form = $derived(rawForm as { error?: string; success?: string } | null);

  let supported = $state(true);
  let deviceName = $state('');
  let busy = $state(false);
  let message = $state('');
  let messageIsError = $state(false);

  // "Add a phone": a QR code, approve the phone that scans it.
  type PairPhase = 'idle' | 'starting' | 'offered' | 'joined' | 'approved' | 'done' | 'ended';
  let mounted = $state(false);
  let pairPhase = $state<PairPhase>('idle');
  let pairId = $state('');
  let pairUrl = $state('');
  let pairQr = $state<QrPath | null>(null);
  let pairLabel = $state('');
  let pairSecondsLeft = $state(0);
  let pairMessage = $state('');
  let pairMessageIsError = $state(false);
  let pairBusy = $state(false);
  let copied = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let deadline = 0;

  onMount(() => {
    supported = browserSupportsPasskeys();
    deviceName = suggestDeviceName();
    mounted = true;
  });
  onDestroy(() => stopPairTimers());

  function stopPairTimers() {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    pollTimer = undefined;
    tickTimer = undefined;
  }

  function countdown(seconds: number): string {
    const safe = Math.max(0, seconds);
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
  }

  async function pairCall(method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch('/mail/passkeys/pair', {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Something went wrong. Try again.');
    return data;
  }

  function endPairing(message: string, isError: boolean) {
    stopPairTimers();
    pairPhase = 'ended';
    pairQr = null;
    pairUrl = '';
    pairMessage = message;
    pairMessageIsError = isError;
  }

  async function startPairing() {
    if (pairBusy) return;
    pairBusy = true;
    pairPhase = 'starting';
    pairMessage = '';
    copied = false;
    try {
      const data = await pairCall('POST', { action: 'create' });
      pairId = String(data.pairingId);
      pairUrl = String(data.pairUrl);
      pairQr = qrPath(pairUrl);
      pairLabel = '';
      deadline = Date.now() + Number(data.secondsLeft) * 1000;
      pairSecondsLeft = Number(data.secondsLeft);
      pairPhase = 'offered';
      pairMessage = 'Scan the code with your phone camera.';
      pairMessageIsError = false;
      stopPairTimers();
      tickTimer = setInterval(() => {
        pairSecondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        if (pairSecondsLeft === 0 && (pairPhase === 'offered' || pairPhase === 'joined' || pairPhase === 'approved')) {
          endPairing('The code expired. Press Add a phone to make a new one.', false);
        }
      }, 1000);
      pollTimer = setInterval(() => { void pollPairing(); }, 2000);
    } catch (error) {
      pairPhase = 'idle';
      pairMessage = error instanceof Error ? error.message : 'Could not start. Try again.';
      pairMessageIsError = true;
    } finally {
      pairBusy = false;
    }
  }

  async function pollPairing() {
    try {
      const data = await pairCall('GET');
      const state = String(data.state);
      if (state === 'joined' && pairPhase !== 'joined') {
        pairLabel = String(data.deviceLabel || 'A phone');
        pairPhase = 'joined';
        pairMessage = `${pairLabel} wants to join. Approve it only if it is your phone and you just scanned the code.`;
        pairMessageIsError = false;
      } else if (state === 'approved' && pairPhase !== 'approved') {
        pairPhase = 'approved';
        pairMessage = `Approved. Now finish on ${pairLabel || 'the phone'}.`;
      } else if (state === 'consumed') {
        stopPairTimers();
        pairPhase = 'done';
        pairQr = null;
        pairUrl = '';
        pairMessage = `${pairLabel || 'The phone'} was added.`;
        pairMessageIsError = false;
        await invalidateAll();
      } else if (state === 'denied') {
        endPairing('That request was ended.', false);
      } else if (state === 'expired') {
        endPairing('The code expired. Press Add a phone to make a new one.', false);
      }
    } catch (error) {
      // A refused poll (signed out, rate limited) ends the offer rather than looping.
      endPairing(error instanceof Error ? error.message : 'Lost contact. Start again.', true);
    }
  }

  async function decide(action: 'approve' | 'deny') {
    if (pairBusy) return;
    pairBusy = true;
    try {
      await pairCall('POST', { action, pairingId: pairId });
      if (action === 'approve') {
        pairPhase = 'approved';
        pairMessage = `Approved. Now finish on ${pairLabel || 'the phone'}.`;
        pairMessageIsError = false;
      } else {
        endPairing('That request was declined.', false);
      }
    } catch (error) {
      pairMessage = error instanceof Error ? error.message : 'Could not do that. Try again.';
      pairMessageIsError = true;
    } finally {
      pairBusy = false;
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(pairUrl);
      copied = true;
    } catch {
      copied = false;
      pairMessage = 'Could not copy. Select the link and copy it.';
      pairMessageIsError = true;
    }
  }

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

  {#if data.pairingAvailable}
    <section class="card" aria-labelledby="phone-heading">
      <h2 id="phone-heading">Add a phone</h2>
      {#if !data.canAdd}
        <p class="muted">{data.addBlockedReason}</p>
      {:else}
        <p class="muted">Show a code here, scan it with your phone camera and the phone makes its own passkey for this account. You do not sign in or type anything on the phone. Do it now, before you need it: if the normal sign-in is down you can still use a passkey you already added.</p>
        {#if pairPhase === 'idle' || pairPhase === 'ended' || pairPhase === 'done' || pairPhase === 'starting'}
          <div>
            <button type="button" class="btn btn-primary" onclick={startPairing} disabled={!mounted || pairBusy}>
              <Icon name="key" size={15} /> Add a phone
            </button>
          </div>
          <noscript><p class="muted">Adding a phone needs JavaScript. Without it, open this page on the phone itself, sign in and use Add a passkey above.</p></noscript>
        {:else}
          {#if pairQr}
            <div class="qr-block">
              <svg class="qr" viewBox="-4 -4 {pairQr.size + 8} {pairQr.size + 8}" role="img" aria-label="QR code for adding a phone. Scan it with the phone camera." shape-rendering="crispEdges">
                <rect x="-4" y="-4" width={pairQr.size + 8} height={pairQr.size + 8} fill="#ffffff" />
                <path d={pairQr.path} fill="#000000" />
              </svg>
              <div class="qr-side">
                <p class="countdown">Expires in <strong>{countdown(pairSecondsLeft)}</strong></p>
                <label class="sr-only" for="pair-link">Pairing link</label>
                <input id="pair-link" class="pair-link" type="text" readonly value={pairUrl} onfocus={(event) => (event.currentTarget as HTMLInputElement).select()} />
                <div class="qr-actions">
                  <button type="button" class="btn btn-subtle" onclick={copyLink}>{copied ? 'Copied' : 'Copy link'}</button>
                  <button type="button" class="btn btn-ghost" onclick={() => decide('deny')} disabled={pairBusy}>Cancel</button>
                </div>
                <p class="muted">The link works once, on one phone, and only if you approve that phone here.</p>
              </div>
            </div>
          {/if}
          {#if pairPhase === 'joined'}
            <div class="approve-box">
              <p><strong>{pairLabel}</strong> wants to join.</p>
              <div class="qr-actions">
                <button type="button" class="btn btn-primary" onclick={() => decide('approve')} disabled={pairBusy}>Approve this phone</button>
                <button type="button" class="btn btn-outline-danger" onclick={() => decide('deny')} disabled={pairBusy}>Deny</button>
              </div>
            </div>
          {/if}
        {/if}
      {/if}
      <p class:error-text={pairMessageIsError} class="status-text" role="status" aria-live="polite">{pairMessage}</p>
    </section>
  {/if}

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
  .qr-block { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .qr { width: 220px; height: 220px; flex: none; border: 1px solid var(--border); border-radius: 6px; }
  .qr-side { display: grid; gap: 8px; min-width: 0; flex: 1 1 220px; }
  .countdown { margin: 0; font-size: 13px; color: var(--text-muted); }
  .pair-link { width: 100%; font-size: 12px; }
  .qr-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .approve-box { padding: 12px; border-left: 3px solid var(--primary); background: var(--bg-subtle); }
  .approve-box p { margin: 0 0 8px; }
  @media (max-width: 600px) {
    .add-form { flex-direction: column; align-items: stretch; }
    .field { min-width: 0; }
  }
</style>
