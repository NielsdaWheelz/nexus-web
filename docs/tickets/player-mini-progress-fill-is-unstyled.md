# player mini progress fill is unstyled

status: open · origin: 2026-10-09 web dead-code sweep (cleanup/web-dead-code, claude session) · area: web / player

`MiniProgress` in `apps/web/src/components/player/GlobalPlayerSurfaces.tsx:474-480`
renders an inner `<span style={{ width }}>` with no class. `Player.module.css`
defines `.miniFill` (display block, full height, `--accent` background, and a
forced-colors override) for that span, but nothing references it: both arrived
in #534 (`289989192`) and the `className={styles.miniFill}` was never wired. an
unclassed inline span ignores `width`/`height`, so the 2px mini progress track
shows no fill. source evidence only; not observed in a browser.

fix: add `className={styles.miniFill}` to the inner span.

acceptance: with a track playing, the collapsed mini player shows an accent
fill whose width follows playback position, in light, dark and forced colors.
