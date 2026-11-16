<script lang="ts">
  // Focused Inbox (docs/focused-inbox.md): which tab this message is in, why,
  // and Outlook's "Move to Other" / "Always move to Other". Rendered only when
  // the message's mailbox is sorted.
  let {
    messageId,
    current,
    why,
    sender,
    canMove = false,
    onMoved = () => {},
  }: {
    messageId: string;
    current: 'focused' | 'other';
    why: string;
    sender: string;
    canMove?: boolean;
    onMoved?: () => void | Promise<void>;
  } = $props();

  let busy = $state(false);
  let error = $state('');
  const target = $derived(current === 'other' ? 'focused' : 'other');
  const targetLabel = $derived(target === 'other' ? 'Other' : 'Focused');

  async function move(always: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const response = await fetch('/api/messages/focus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [messageId], to: target, always }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: unknown };
      if (!response.ok) throw new Error(typeof payload.message === 'string' ? payload.message : 'Couldn\'t move this message');
      await onMoved();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Couldn\'t move this message';
    } finally {
      busy = false;
    }
  }
</script>

<section class="focus-note" aria-labelledby="focus-note-title">
  <p>
    <strong id="focus-note-title">In {current === 'other' ? 'Other' : 'Focused'}.</strong>
    <span class="why">{why}</span>
  </p>
  {#if canMove}
    <div class="focus-actions" aria-busy={busy}>
      <button type="button" class="btn btn-sm" disabled={busy} onclick={() => move(false)}>Move to {targetLabel}</button>
      <button type="button" class="btn btn-sm" disabled={busy} onclick={() => move(true)} title={sender ? `Messages from ${sender}` : undefined}>
        Always move messages from this sender to {targetLabel}
      </button>
    </div>
  {/if}
  {#if error}<p class="focus-error" role="alert">{error}</p>{/if}
</section>

<style>
  .focus-note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 6px 14px;
    margin: 0 0 12px;
    padding: 6px 0 6px 10px;
    border-left: 2px solid var(--border-strong, var(--border));
    color: var(--text-muted);
    font-size: 12.5px;
  }
  .focus-note p { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .focus-note strong { color: var(--text); font-weight: 600; }
  .focus-actions { display: flex; flex-wrap: wrap; gap: 4px; }
  .focus-actions .btn { border-color: transparent; background: transparent; color: var(--primary-text); font-weight: 400; }
  .focus-actions .btn:hover:not(:disabled) { background: var(--bg-hover); }
  .focus-error { flex-basis: 100%; color: var(--danger); }
  @media (max-width: 600px) {
    .focus-actions { width: 100%; }
    .focus-actions .btn { min-height: 44px; }
  }
</style>
