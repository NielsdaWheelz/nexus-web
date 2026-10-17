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
tokens owned by `PaneShell`'s control row: field/button heights grow with
content, with 32px fine-pointer and 44px coarse-pointer minima. non-pane size
defaults remain unchanged. `SelectField`'s `Inline` layout owns the label and
native intrinsic value width; the whole control wraps before its label stacks.
`Stacked` forms keep their layout.

`PaneQueryToolbar` groups controls by pane width. its boxed input always reserves
the clear slot, so typing/clearing preserves the input's bounds and node.
applied text, chips, visible status and reset wrap in one compact summary;
errors and expanded options share its bounded refinement region. shell
measurement publishes the cap. essential controls never depend on horizontal
scrolling. see [workspace controls](workspace.md), the
[toolbar specification](../pane-query-toolbar-plan.md) and
[browser qualification](../pane-query-toolbar-verification.md). the latter
includes native firefox 158 page/text zoom at 200% in a 320px pane; it makes
no spoken assistive-technology claim.

## choice controls

`ChoicePicker` renders one controlled exclusive choice: the current value and a
chevron, with the category in its accessible name. its plain list has separate
active and selected states, a selected checkmark and visible unavailable reasons.
labels wrap rather than truncate; the bounded list scrolls vertically. status
and refresh content sits outside the listbox. it has no search field or visible
category heading. command menus and library membership retain their own content
and semantics; [overlays](overlays.md#surfaces) owns the responsive picker shell.

choice triggers have a 32px minimum height; triggers and option rows have at
least 44px with any coarse pointer. text can increase those heights. engagement
uses existing colour and motion tokens; reduced motion removes transitions.
chat's three-control composition, native effort gauge/range and whole-control
wrapping belong to [chat](chat.md#generation-selection), not this primitive.

## overflow buttons

`OverflowMenuButton` owns ellipsis trigger appearance: one native button,
centered 18px lucide glyph, 6px corners, a persistent neutral border and
hover/press/open/disabled/focus paint. it forwards native attributes, handlers
and refs without owning interaction state. `ActionMenu` supplies behavior and
aria bindings, not a visual class. semantic custom triggers own their appearance.
resource outlines compose relationship and resource verbs in this same menu;
their compact fine-pointer trigger is 24px and their coarse trigger 32×44px,
inside a reserved action column that never shifts content.

default targets are 32px, at least 44px with any coarse pointer. consumer classes
adjust geometry and noninteractive adornments only: mobile chrome/switchboard
retain 48px and desktop nexus retains its wider shortcut-bearing button.
disabled paint overrides engagement; focus remains visible. forced colors use
system colors, including a contrasting focus ring for disabled expanded controls.
theme colors and motion come from existing tokens; reduced motion removes the
color transitions. no geometry motion or state-dependent sizing.

## the lint

`lint:css-tokens` runs in `./scripts/test` after `build:shelf` and
`build:extension` and fails on a colour literal outside the owners above, or a
`var()` that resolves nowhere: not declared in any `src` css, not installed at
runtime (next/font variables, `--moon`, `--grain-seed`, measured geometry) and
without a fallback. the android shelf and the firefox popup load no hosted
stylesheet, so each built bundle is checked against its own declarations, where
next/font variables do not count (their packaged stacks must be declared).
