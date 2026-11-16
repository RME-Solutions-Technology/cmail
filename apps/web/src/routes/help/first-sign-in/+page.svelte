<script lang="ts">
  import { page } from '$app/state';

  let { data } = $props();
  const appName = $derived(page.data?.appName || 'this mail service');
  const orgName = $derived(page.data?.orgName || 'your organisation');
  const supportEmail = $derived(page.data?.supportEmail || '');
</script>

<article class="guide">
  <header>
    <p class="eyebrow">First sign-in</p>
    <h1>Sign in to {appName} for the first time</h1>
    <p>{orgName} has set up a mail account for you in {appName}. Sign in once now, so it is ready if you ever need it. It takes about two minutes.</p>
  </header>

  <section id="steps">
    <h2>The steps</h2>
    <ol>
      {#if data.viaAccess}
        <li>Open {appName} and sign in with your work account when asked.</li>
      {:else}
        <li>Open {appName} and choose <strong>Sign in with Microsoft</strong>. Use your work account, the one you use for Microsoft 365 at {orgName}.</li>
      {/if}
      <li>If you are asked to accept the IT policy, read it and accept it.</li>
      {#if data.passkeys}
        <li>Add a passkey. In the left menu choose <strong>Settings</strong>, then <strong>Passkeys</strong>, then <strong>Add passkey</strong>. Do this soon after you sign in.</li>
      {/if}
    </ol>
  </section>

  {#if data.passkeys}
    <section id="passkey">
      <h2>What is a passkey?</h2>
      <p>A passkey lets you sign in with your fingerprint, face or device PIN instead of a password. It stays on your device or in your password manager. Having one means you can still get into your email through {appName} if Microsoft sign-in is ever unavailable.</p>
      <p>You can add more than one passkey, for example on your phone and your laptop. {appName} never sees your fingerprint or face.</p>
    </section>
  {/if}

  <section id="help">
    <h2>Who to contact</h2>
    {#if supportEmail}
      <p>Stuck, or not sure this email is genuine? Contact <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.</p>
    {:else}
      <p>Stuck, or not sure this email is genuine? Ask your IT contact at {orgName}.</p>
    {/if}
    <p>{orgName} will never ask for your password by email.</p>
  </section>
</article>

<style>
  @import '../getting-started/guide.css';
</style>
