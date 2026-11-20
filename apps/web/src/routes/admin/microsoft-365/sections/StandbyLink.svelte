<script lang="ts">
  import { STANDBY_SWITCH_SOONER_NOTE } from '@cmail/shared/graph-mirror';
</script>

<section class="m365-section" aria-labelledby="standby-link-title">
  <header class="section-heading">
    <h2 id="standby-link-title">Standby</h2>
    <p>The standby address and its daily test have their own page.</p>
  </header>
  <div class="notice" role="note" data-testid="standby-link-note"><strong>Switching to the standby:</strong> {STANDBY_SWITCH_SOONER_NOTE}</div>
  <p><a class="btn" href="/admin/standby">Open Standby test</a></p>
</section>

<style>
  .m365-section { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .section-heading h2 { margin: 0 0 6px; font-size: var(--fs-title-3, var(--fs-subtitle)); font-weight: 600; }
  .section-heading p { max-width: 760px; margin: 0; color: var(--text-muted); font-size: var(--fs-body); font-weight: 400; }
  .notice { overflow-wrap: anywhere; padding: 8px 12px; border: 0; border-left: 3px solid var(--border); background: var(--bg-subtle); color: var(--text); }
  p { margin: 0; }
</style>
