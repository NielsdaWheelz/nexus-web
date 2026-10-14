# visual system

## scope

the look and the voice: three rooms of colour and type, the controls every pane
is built from, the chrome above a pane, the row every list is built from, and
how nexus says something happened. owners, under `apps/web/src/`:

- `app/globals.css`: every token, the three rooms, the oracle scope, the
  degradation media list, the reset, grain, scrollbars and find highlights.
- `lib/theme/room.ts` (room type, cookie name, browser-chrome colours,
  `parseRoom`), `cookie.ts` (server read), `elvishInscriptions.ts`;
  `components/theme/SolarEffects.tsx`; the appearance pane owns the browser write.
- `components/feedback/Feedback.tsx`: signals (huds, persistent notices) and
  in-flow notices.
- `components/ui/*` except the overlay kernel's files ([overlays](overlays.md));
  `Field.module.css` is the one appearance of `Input`, `Textarea`, `Select` and
  `SelectField`.
- `lib/ui/{eventTarget,viewTransitions,actionDescriptor,copyText,rovingIndex}.ts`.
- `scripts/check-css-tokens.mjs` (`bun run lint:css-tokens`).

## rooms

`html[data-theme]` is `light` (Study), `dark` (Press, the default) or `elvish`
(Solar). the `nx-theme` cookie names the room (absent means Press; a year,
path `/`, Lax, Secure when deployed); the root layout reads it for the first
paint and the `theme-color` meta (`ROOM_CHROME`). choosing a doorway repaints at
once (attribute and meta) and writes the host-only cookie locally: one year,
path `/`, lax, secure on https. no authenticated request, router refresh or save
message; the final choice wins even while offline. `data-theme` may nest (the settings plates). the oracle and atlas
routes set `[data-theme="oracle"]`, a manuscript palette that ignores the room.

## tokens

a module names `--danger`, never a colour. colour literals live only in
`globals.css`, `brand.css`, the reader theme (`documentReader.module.css`:
`::highlight` ignores `var()` on chromium and android webview ≤ 113) and the
oracle and atlas routes. rooms redefine colour, shadow, grain, hairline, body
size and tracking only. text on an 18% tint of its own tone (`Pill`) reads the
tone's `--*-ink` step, which holds 4.5:1 over that tint.

## the solar's ornament

every ornament is a pseudo-element whose opacity is multiplied by `--ornament`
(1 Illuminated, .5 Whisper, 0 Bare), so at 0 nothing moves. a region demotes
its subtree with `calc(.5 * var(--ornament-root))`, never from `--ornament`
itself (a cycle). forced colours, `prefers-contrast: more` and print set the
dimmer and the grain to 0; tables, code and fields are Bare by construction.
ornaments live in four modules: the pane header's vine and tehta, the row's
lamp and leaf, the empty slot's corner branches, the hud's brass rim and the
empty headline's star.

- **the moon slot law.** `--moon` (0.15 new to 1 full, set once per mount by
  `SolarEffects`) may enter only an opacity, a drop-shadow blur radius or the
  hue slot of an `oklch()`; never a lightness, chroma or colour. no contrast
  ratio may vary with the moon. review holds it (three uses, one module).
- **the tengwar law.** no tengwar webfont ships and no computed string is set in
  tengwar: inscriptions are baked outlines drawn as `aria-hidden` svg, the
  english beside them carries the meaning. review holds it.

## signals

- **hud** (bottom-right, 420px; full width on phones): leaves after 5 s, 10 s
  with actions; hover, focus within or a hidden tab holds the clock and keeps
  the remainder; at most three, a fourth evicts the oldest hud nobody holds; ×
  dismisses; an action runs and closes it, even if it throws.
- **persistent notice** (the rail under the app, ≤48% of the height, 42% on
  phones; a registered mobile bottom surface): leaves by its producer's
  `resolve(key)` or by its ×; Retry runs and keeps it; a later failure brings it
  back.
- a keyed publish of the same kind replaces in place (same element, holds kept,
  no re-entry) and restarts a hud's clock; identical content changes no dom, so
  it is not announced again.
- announcement is the dom: huds render into `section[aria-label="Notifications"]`
  and notices into `section[aria-label="Notices"]`, both `aria-live="polite"`
  and present from the first paint; an assertive notice is `role="alert"`.
- **notice** (`FeedbackNotice`): the same anatomy in flow; `Polite` is
  `role="status"`, `Assertive` `role="alert"`, `None` silent. `FieldFeedback`
  sits under its field, referenced by id.

## ownership

`globals.css` customizes scrollbars only for a fine primary pointer with hover;
touch uses platform defaults at every viewport width. this follows input,
independently of the workspace's layout breakpoints.

the shared reader supplies passive touch indicators because android webview
suppresses native indicators inside nested scroll containers. text and pdf hide
their native scrollbars and share the overlay: zero layout width, pixel scroll
position in both axes, visible during movement, then fading after 400ms idle.
it takes neither pointer nor keyboard input and records no reading progress.

no module styles another module's internal dom. a caller adjusts a primitive
only through its props, its `className` (a field primitive's rules weigh one
class, so the caller's class meets them at equal weight) or a context token the
primitive declares. pane query/navigation controls share declared density
tokens owned by `PaneShell`'s control row; `SelectField`'s `Inline` layout owns its label and native select.
`PaneQueryToolbar` owns wrapping and one bounded refinement region; shell
measurement publishes its maximum height. essential controls never depend on
horizontal scrolling. see [workspace controls](workspace.md).

## the lint

`lint:css-tokens` runs in `./scripts/test` after `build:shelf` and
`build:extension` and fails on a colour literal outside the owners above, or a
`var()` that resolves nowhere: not declared in any `src` css, not installed at
runtime (next/font variables, `--moon`, `--grain-seed`, measured geometry) and
without a fallback. the android shelf and the firefox popup load no hosted
stylesheet, so each built bundle is checked against its own declarations, where
next/font variables do not count (their packaged stacks must be declared).
