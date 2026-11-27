<!--
  Mark — the Stanchion app symbol.

  An orange rounded square carrying a dark envelope (body, flap line and a
  base bar), the same mark as stanchion.app. `tone` is kept so existing
  callers still compile: the orange tile reads on both the white page and the
  navy suite header, so both tones draw the same mark.
-->
<script>
  /** @type {{ size?: number, tone?: 'brand' | 'onDark', id?: string, class?: string }} */
  let { size = 28, tone = 'brand', id = 'mk', class: klass = '' } = $props();
  // `tone` and `id` are accepted for compatibility; the mark has no gradients.
  void tone; void id;
</script>

<svg
  class={klass}
  width={size}
  height={size}
  viewBox="0 0 32 32"
  role="img"
  aria-label="Stanchion"
  focusable="false"
  style="display: block;"
>
  <rect width="32" height="32" rx="8" fill="#f6821f" />
  <rect x="4" y="6" width="24" height="14" rx="2.5" fill="#1d1f23" />
  <path d="m6 8.5 10 7 10-7" fill="none" stroke="#f6821f" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
  <rect x="4" y="23" width="24" height="3" rx="1.5" fill="#1d1f23" />
</svg>
