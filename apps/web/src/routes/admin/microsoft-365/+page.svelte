<script lang="ts">
  import Connection from './sections/Connection.svelte';
  import DirectorySync from './sections/DirectorySync.svelte';
  import SharedMailboxAccess from './sections/SharedMailboxAccess.svelte';
  import WelcomeEmails from './sections/WelcomeEmails.svelte';
  import MailFeed from './sections/MailFeed.svelte';
  import StandbyLink from './sections/StandbyLink.svelte';

  let { data, form } = $props();

  const appName = $derived(data.appName || 'cmail');
  // A result message reaches only the section whose button was pressed.
  const shown = (section: string) => (form?.section === section ? form : null);

  const SECTIONS = [
    { id: 'connection', label: 'Connection' },
    { id: 'directory-sync', label: 'Directory sync' },
    { id: 'shared-mailbox-access', label: 'Shared mailbox access' },
    { id: 'welcome-emails', label: 'Welcome emails' },
    { id: 'mail-feed', label: 'Mail feed' },
    { id: 'standby', label: 'Standby' },
  ];
</script>

<svelte:head><title>Microsoft 365 · Management · {appName}</title></svelte:head>

<div class="m365-page">
  <header class="page-heading">
    <p class="eyebrow">Identity &amp; organisation</p>
    <h1>Microsoft 365</h1>
    <p>Everything {appName} does with your Microsoft 365 tenant, in one place: the connection, the directory sync, shared mailbox access, welcome emails and the mail feed.</p>
  </header>

  <nav class="jump" aria-label="Sections on this page">
    {#each SECTIONS as section (section.id)}<a href={`#${section.id}`}>{section.label}</a>{/each}
  </nav>

  <div id="connection"><Connection {data} /></div>
  <div id="directory-sync"><DirectorySync data={{ ...data, overview: data.sync }} form={shown('sync')} /></div>
  <div id="shared-mailbox-access"><SharedMailboxAccess data={{ ...data, overview: data.access }} form={shown('access')} /></div>
  <div id="welcome-emails"><WelcomeEmails {data} form={shown('welcome')} /></div>
  <div id="mail-feed"><MailFeed data={{ ...data, overview: data.feed }} form={shown('mirror')} /></div>
  <div id="standby"><StandbyLink /></div>
</div>

<style>
  .m365-page { display: grid; gap: 36px; max-width: 960px; }
  .page-heading h1 { margin: 2px 0 6px; font-size: var(--fs-title-2); font-weight: 600; }
  .page-heading > p:last-child { max-width: 760px; margin: 0; color: var(--text-muted); font-size: var(--fs-body); font-weight: 400; }
  .eyebrow { margin: 0; }
  .jump { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; }
  .m365-page > div { scroll-margin-top: 16px; min-width: 0; }
  .m365-page { min-width: 0; }
  .jump a { overflow-wrap: anywhere; }
</style>
