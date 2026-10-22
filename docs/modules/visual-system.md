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
- `components/feedback/Feedback.tsx`: shared status, notice, surface and field
  presentation; `workspaceSignals.ts` owns account-scoped workspace presentation.
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
ornaments stay in pane headers, resource rows and empty surfaces. feedback
uses the same restrained anatomy in every room.

- **the moon slot law.** `--moon` (0.15 new to 1 full, set once per mount by
  `SolarEffects`) may enter only an opacity, a drop-shadow blur radius or the
  hue slot of an `oklch()`; never a lightness, chroma or colour. no contrast
  ratio may vary with the moon. review holds it (three uses, one module).
- **the tengwar law.** no tengwar webfont ships and no computed string is set in
  tengwar: inscriptions are baked outlines drawn as `aria-hidden` svg, the
  english beside them carries the meaning. review holds it.

## signals

`FeedbackStatus`, `FeedbackNotice`, `FeedbackState` and `FieldFeedback` share
plain-text content and tone tokens. no severity label, coloured card or custom
feature renderer. the complete fact and first action are visible; detail,
diagnostics and a second action expand on demand. navigation remains a link.
inline disclosure pushes layout; the reader and workspace opt into the existing
anchored surface. native menu and player controls retain their widget semantics.

one account-scoped in-flow workspace slot shows the highest-priority current
condition, then optional offers. conditions rank write, action, status; offers
follow. `+n` opens all current items. hover, focus and disclosure freeze order.
owners project conditions through `useWorkspaceCondition`; they alone decide
settlement and retry, except that content needing a page reload (a stale
build) offers only reload. optional `offer` handles update/withdraw one exact
publication, and cannot resurrect a dismissed/replaced occurrence. busy offers
cannot be dismissed. required recovery has no dismiss control.

an actionless `receipt` gets five visible seconds only when the slot is empty.
there is no queue or history. consequential work and a modal suppress receipts;
they never replay. account departure retires presentation. an active modal
suppresses unrelated workspace controls and live announcements; its own failures
stay inside the modal.

only changed short facts enter separate live regions. inactive panes stay
silent. actions stay mounted and focusable while busy, with guarded activation;
successful removal returns to an explicit owner destination, then the shell.
`FeedbackScope` supplies a pane's focus destination and announcement permission
without a new state owner. disabled reasons remain visible. compact targets are
32px, 44px with a coarse pointer; required text wraps. all rooms, forced colours
and reduced motion share the same contract. the cutover plan in #650
owns the complete api and behavior requirements.

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
scrolling. see [workspace controls](workspace.md) and the toolbar
specification and browser qualification in #628. the latter
includes native firefox 158 page/text zoom at 200% in a 320px pane; it makes
no spoken assistive-technology claim.

## collections and searchable pickers

`components/ui/Collection.module.css` owns shared surface, row, search, detail,
adornment and viewport recipes. semantic components retain their actual roots:
native commands/links, exclusive choices, search listboxes and launcher grids.
feature css arranges content; it does not duplicate interaction paint.

transient results have a six-row preferred budget (32px fine, 44px coarse), not
a result-count limit. full workspaces retain their larger area. essential names
wrap. `lib/ui/collection.ts` owns scoped reveal and constrained-body measurement;
[overlays](overlays.md#surfaces) owns available geometry and dismissal.

`lib/ui/searchOptions.ts` supplies controlled bindings and keyed reconciliation.
the feature owns one active record for raw query, scope and subject/session.
only admitted current results can activate. first enabled existing results
highlight automatically, including people and library actions; creation requires
deliberate navigation or a completed press. refresh/append preserves identity;
removal retires it without choosing a neighbour. disabled rows explain their
reason without activating. composition, repeats and modified editing do not act.

highlight is the current suggestion, separate from membership/current-value
marks. adapters own labels/descriptions and acknowledgement semantics. feedback
and retry controls remain outside listboxes. editor suggestions stay inline;
the editor retains focus and its insertion transaction. native selects and the
launcher's specialized grid keyboard controller retain their own semantics.

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

## action controls

`Button.tsx` executes commands with a native button; `ButtonLink.tsx` navigates
with a native anchor. `control.tsx` and `Control.module.css` own their appearance,
content and help composition. `buttonClassName` is the pure recipe for existing
framework, reader and navbar roots; it owns no routing, operations or focus.
ordinary prose links and specialized widgets retain their own semantics.

quiet is the default. `emphasis="strong"` marks a principal commitment;
`tone="danger"` marks destruction independently. `size="comfortable"` has a 44px
minimum; compact controls use their host minimum or 32px. any coarse pointer
enforces at least 44px in both axes. the existing dense outline exception is
24px with fine input; mobile headers remain 48px. geometry hooks are
`--control-min-size`, `--control-icon-size`, `--control-font-size` and
`--control-radius`. callers own layout and adornments, never internal selectors
or competing interaction paint. fields retain their separate density tokens.

icon-only controls require an icon and accessible name; decorative glyphs are
hidden and help defaults to that name. labeled controls retain visible text;
explicit help requires text. `aria-busy` changes the existing icon slot without
changing activation policy. the operation owner chooses native `disabled` or
guarded, focusable `aria-disabled`. blocked control links retain their anchor,
name and explicit tab policy, omit href and suppress activation before callbacks.
enabled links retain native navigation. no action is inferred from styling.

help, busy and selection changes preserve the native root. tooltip composition
retains actual refs, react callback cleanup, caller handlers and description ids.
disabled paint overrides every tone/selection state; focus stays visible.
forced colors use system colors; reduced motion stops color transitions and busy
rotation. colors, type and spacing use existing tokens; no geometry animation.

## overflow buttons

`OverflowMenuButton` is the named 16px/1.5-stroke ellipsis adapter over `Button`;
shared controls own its paint and busy glyph. it forwards native attributes,
handlers and refs without owning interaction state. `ActionMenu` supplies behavior and
aria bindings, not a visual class. semantic custom triggers own their appearance.
resource outlines compose relationship and resource verbs in this same menu;
their compact fine-pointer trigger is 24px and their coarse trigger 44×44px,
inside a reserved action column that never shifts content.

`ResourceRow` declares shared outline geometry: 24px controls with a fine pointer,
44×44px with any coarse pointer, and 2px gaps. outline indentation and creation
alignment consume the same geometry. note-pane margins follow containing width,
bounded from 8px to 24px. reference carets reserve one control width at the text's
end for focus placement. nested search passages begin in the branch tail, without
also inheriting the parent body column's leading and trailing control gutters.
`OverflowMenuButton` declares sizing tokens; consumers do not
reach through its internal button markup.

ordinary `ResourceRow` leading controls consume that same geometry. its optional
passive `leadingVisual` slot occupies a separate column across both text rows,
aligned at the top; expanded content starts at the text column. omitted visuals
reserve no gutter. podcast list artwork uses a fixed 44px square (`--size-xl`),
`--space-2` gap, `--radius-sm` corners and `--surface-2` background. containment
preserves the complete publisher image and can letterbox it. existing compact
title clamping, metadata ellipsis and status placement remain in force.

mobile chrome/switchboard retain 48px and desktop nexus retains its wider
shortcut-bearing control through the same geometry contract.

## workspace strip

the desktop workspace strip keeps readable 12–15rem chips in its own horizontal
scrollport. each chip has a title, overflow and stable close target: 32px within
the 40px strip, or 44px within 52px when any pointer is coarse. active fill,
in-view tick and minimized treatment remain distinct. keyboard focus reveals
only this strip. reduced motion removes displacement transitions; forced colors
retain selection and focus. tab actions share content with manage tabs through
`lib/workspace/paneActions.ts`; completion uses one polite position announcement.

## the lint

`lint:css-tokens` runs in `./scripts/test` after `build:shelf` and
`build:extension` and fails on a colour literal outside the owners above, or a
`var()` that resolves nowhere: not declared in any `src` css, not installed at
runtime (next/font variables, `--moon`, `--grain-seed`, measured geometry) and
without a fallback. the android shelf and the firefox popup load no hosted
stylesheet, so each built bundle is checked against its own declarations, where
next/font variables do not count (their packaged stacks must be declared).
