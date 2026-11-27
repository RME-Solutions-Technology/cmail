# Stanchion brand assets

The mark and favicon are SVG. The two PNGs exist only because the PWA manifest
requires raster icons; they are rendered from `icon.svg`.

| File | Size | Use |
|---|---|---|
| `favicon.svg` | 32×32 | browser tab icon (referenced in `app.html`) |
| `icon.svg` | 32×32 grid | square mark: nav, PWA, app stores |
| `icon-192.png` / `icon-512.png` | raster | PWA manifest, Apple touch icon |
| `logo.svg` | 320×96 | horizontal lockup: sign-in page default (an organisation can set its own with BRAND_LOGO_URL) |
| `og-image.svg` | 1200×630 | social card: orange mark and name on a light ground |

## The mark

An orange rounded square (#f6821f, radius 8 on a 32 grid) carrying a dark
(#1d1f23) envelope: a body, a flap line cut in the tile colour, and a base bar.
It is the same mark as stanchion.app. In the app it is drawn by `Mark.svelte`.

## The name

The name is set in the display face, lower case in the lockup (`logo.svg`),
dark on a light ground. In the app `Brand.svelte` sets the tenant's `APP_NAME`
next to the mark. There is no drawn wordmark any more.

## Sign-in

The organisation comes first: its own logo if `BRAND_LOGO_URL` is set, else the
Stanchion lockup. The footer carries one quiet line, "Powered by Stanchion".
