# Icons

Framework-level icons, vendored as static SVGs (served same-origin, immutable cache).

## Sources & Attribution

| Set | License | Files | Used for |
|---|---|---|---|
| [Tabler Icons](https://github.com/tabler/tabler-icons) | MIT | `search`, `settings-2`, `music`, `player-*`, `arrows-shuffle`, `repeat`, `volume`, `playlist`, `cloud-rain`, `photo`, `brand-github`, `info-circle`, `external-link`, `x`, `trash`, `upload`, `refresh`, `map-pin`, `compass` | UI controls (buttons, player controls, settings) |
| [Lawnicons](https://github.com/LawnchairLauncher/lawnicons) by the Lawnchair team | Apache-2.0 | `sparkle`, `translate_you`, `generic_clock` | Framework identity / favicon, translator app, clock |

All SVGs are unmodified copies of the originals. Thank you to both projects and their
contributors — these outline-style icons are what give YingoTab its visual language.

## Icon resolution in `yingotab.yml`

The `icon` field of an app supports, in order:

1. `lawnicons:<name>` — fetched live from jsDeliv (`svgs/<name>.svg`), rendered inline.
   Prefer this in content repos to keep a consistent outline style with zero asset cost.
2. Fixed asset name — one of the vendored files above (extension optional).
3. Any `https://…` image URL.
4. Emoji.

Fallback chain ends at the default placeholder if everything fails.

## Styling

SVGs are rendered inline with `stroke: currentColor` where possible, so they follow
text color and adapt to light/dark wallpapers automatically. On dark wallpapers the
`original-color` variants are inverted via CSS filter (`original-color` class + invert).
