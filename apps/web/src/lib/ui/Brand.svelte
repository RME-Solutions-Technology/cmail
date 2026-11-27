<!--
  Brand — the mark + name lockup.

  Stanchion is whitelabel: APP_NAME is set per tenant. The name is set in the
  display face with the wordmark's optical tracking, so a renamed deployment
  looks designed rather than defaulted.
-->
<script>
  import Mark from './Mark.svelte';

  /**
   * @type {{
   *   name?: string,
   *   size?: number,
   *   tone?: 'brand' | 'onDark',
   *   id?: string,
   * }}
   */
  let { name = 'Stanchion', size = 28, tone = 'brand', id = 'brand' } = $props();
</script>

<span class="brand" style="--brand-size: {size}px">
  <Mark {size} {tone} id="{id}-mk" />
  <span class="brand-word">
    <span class="brand-name">{name}</span>
  </span>
</span>

<style>
  .brand {
    display: inline-flex;
    align-items: center;
    gap: calc(var(--brand-size) * 0.32);
    line-height: 1;
    color: inherit;
  }
  .brand-word { display: inline-flex; align-items: center; }
  .brand-name {
    font-family: var(--font-display, inherit);
    font-size: calc(var(--brand-size) * 0.66);
    font-weight: 600;
    letter-spacing: -0.025em;
    white-space: nowrap;
    color: inherit;
  }
</style>
