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
  presentation; `scope.ts` composes mounted contributions and `FeedbackLayer.tsx`
  owns passive placement.
- `components/ui/*` except the overlay kernel's files ([overlays](overlays.md));
  `Field.module.css` is the one appearance of `Input`, `Textarea`, `Select` and
  `SelectField`.
- `lib/ui/{eventTarget,actionDescriptor,copyText,rovingIndex}.ts`.
- `scripts/check-css-tokens.mjs` (`bun run lint:css-tokens`).

## design intent

nexus is a private instrument for attention. the rooms, local typography,
restrained ornament and editorial lists express that purpose. polish preserves
the user's place, caret, selection and return path across transient surfaces;
animation cannot substitute for that continuity. consequential save, failure and
source-availability facts remain visible where the user can act on them.

phone composition allocates space to prose while preserving distinct usable
targets. fewer simultaneous commands and deliberate selection are the accepted
cost of that space. shared controls own appearance and interaction primitives;
domain owners retain command meaning, state and authority. source text, personal
writing and generated interpretation keep distinguishable attribution.

new contextual intelligence uses the existing [tool authority](model-tools.md)
and [source evidence](resource-references.md). the
[reading proposals](../scriptorium.md#contextual-reading-proposals) are ideas,
not shipped capabilities or a requirement for another dashboard.

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
oracle and atlas routes. shared defaults for scales, sans and mono faces,
spacing, motion, dimensions, focus metrics, scrims, highlights and shell geometry
live in a `:root`-only block before reduced-motion overrides. nested rooms inherit
them from the nearest ancestor, including overrides supplied by context owners.
the press block (`:root, [data-theme="dark"]`) declares only tokens another room
overrides: colour, shadow, grain, hairline, body size, tracking, serif face and
the section-title font role. text on an 18% tint of its own tone (`Pill`) reads
the tone's `--*-ink` step, which holds 4.5:1 over that tint.

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

ordinary selection, autosave, synchronization and successful refresh are silent.
foreground waiting occupies an existing fixed control slot, with immediate
`aria-busy` and a spinner after 200 ms. settlement removes the spinner immediately;
subject changes cancel its timer. root reads use pane chrome, without skeletons or
status paragraphs. otherwise invisible success uses a 1.2-second checkmark in the
same slot; copy also announces `copied` once. `useCopyFeedback` owns that timing,
never the caller's command or clipboard recovery.

`FeedbackStatus`, `FeedbackNotice`, `FeedbackState` and `FieldFeedback` retain real
task facts, empty/unavailable content, fatal entry failure and field validation.
recoverable operational failures use `FeedbackFailure`: content, at most two real
actions and an owner-supplied incident identity. retry preserves the incident and
its mounted controls. dismissal acknowledges presentation only; it never discards
a command, draft, uncertainty or loss guard.

`FeedbackScope` composes mounted local contributors, with token-checked cleanup
and occurrence deduplication. the provider has one authored-account projection;
domain commands remain in their existing owners. weak acknowledgement and
last-published speech metadata survive host relocation without retaining command
payloads or failure history. a deliberate retry outcome may announce once with a
new speech token. rerenders, background retries and relocation remain silent.

one passive `FeedbackLayer` belongs to each real pane, modal, picker or standalone
surface. modal portals inherit the actual overlay context. only the existing
topmost interaction owner is eligible; without one, the active pane or standalone
surface is eligible. inactive scopes retain contributions without displaying or
speaking. source-owned feedback disclosures retain their source's eligibility;
a newer unrelated interaction wins.

cards stack in that single layer, bounded by the host and visual viewport. the
preferred placement protects whole focused editables, controls and modal control
regions. inability to fit minimizes to a permanently reserved recovery slot;
there is no corner search, forced scroll, chrome reveal or caret tracking. explicit
recovery opens the existing anchored surface. feedback's own controls and
disclosures do not obstruct themselves; an engaged card stays bounded and
scrollable as space shrinks. appearance never takes focus. withdrawal may restore
only removed owned focus, when no surviving control has acquired it and the host
remains eligible.

`receipt(content, action?)` remains disposable, never the sole recovery path. it
uses the same host layer. one current outcome and at most one waiting outcome
retain the existing five/eight visible-second expiry, hold, suppression and
retraction rules. a returning receipt does not announce again. action
`commandKey` prevents a held control silently changing its command.

`Signal` shares content, tone, diagnostics and actions across these presentations.
controls never enter live regions. details and diagnostics open on demand;
recovery stays outside document and list flow. all rooms, forced colours, reduced
motion and coarse targets retain the same contracts.

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
tokens owned by `CompactChrome.module.css`, applied to pane control rows,
companion headers, workspace strips and connections controls. targets grow with
content, with 32px fine-pointer and 44px any-coarse-pointer minima. chrome stays
13px; coarse text-entry/native-select values use 16px. the two type roles are
independent. non-pane field defaults remain unchanged. `SelectField`'s `Inline` layout owns the label and
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

## pane sections

`PaneSection` is one open, transparent section: optional interface header and
body, separated by 12px, with no perimeter, clipping or nested inset. native
section props and refs pass through; it owns no reads, commands or state.
callers retain their fields, tables and collection rows without a boxed variant.
`PaneSurface` supplies 16px outer padding, 12px minor stacks and 24px major
content gaps; statistics owns the equivalent 24px section margin locally.

`--pane-section-title-font` is a complete font shorthand resolved through the
nearest theme: garamond 500 at 24px/1.2 in the study, sans 600 at 18px/1.35 in
the press, cormorant 300 at 24px/1.2 in the solar. headings reset tracking and
inherit section ink; descriptions use `--ink-muted`. the header owns interface
typography independently of reader prose. headings and actions wrap at the
containing width; control targets remain owned by their controls.

## collections and searchable pickers

`components/ui/Collection.module.css` owns shared surface, row, search, detail,
adornment and viewport recipes. semantic components retain their actual roots:
native commands/links, exclusive choices, search listboxes and launcher grids.
feature css arranges content; it does not duplicate interaction paint.

search/catalog results use `compactViewport`'s six-row preferred budget (32px
fine, 44px coarse), not a result-count limit. actions and standalone chapters use
`contentViewport`: intrinsic height, capped by anchored bounds and the parent's
flex allocation, without a measured collection ceiling or minimum viewport row.
short lists do not stretch. full workspaces retain `fillViewport`'s larger area.
essential names wrap. `lib/ui/collection.ts` owns constrained-body measurement
and reveals retained focus after resize within the owned list/body, without
moving focus or scrolling the host;
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

choice triggers and segments have a 32px minimum height; triggers, option rows
and segments have at least 44px with any coarse pointer. text can increase those
heights. engagement uses existing colour and motion tokens; reduced motion
removes transitions. chat's three-control composition, native effort gauge/range
and whole-control wrapping belong to [chat](chat.md#generation-selection), not
this primitive.

an exclusive choice shown as its options is a native radio group, `RadioGroup`:
one fieldset named by its legend, radios sharing one `useId` name, and an
optional description after the options that describes the fieldset. it adds no
role. inside `role=menu` the same choice is `menuitemradio`
([overlays](overlays.md#surfaces)). `Inline` is the default presentation.
`Segmented` sets each option as a `ChoiceField` segment in one track of equal
columns whose labels wrap; its visible legend takes the form-label type, and a
`Hidden` legend names the group to assistive technology only. a choice label may
be a node, such as a font named in its own face, beside a decorative icon.

`ChoiceField.module.css` owns native label/input geometry and the public group,
choices and group-description layouts. names reference label-only spans;
help and caller descriptions remain separate. refs address the actual inputs.
inline choices use native checked marks without selected backplates.

`Selection.module.css` owns surface, target and selected appearance for native
segments, menu radios, companion tabs and pane activation. selected is a neutral
surface with an inset bottom accent marker; hover preserves it. focus remains
separate. disabled selected values retain a neutral marker. forced colors use
system colors and preserve marker/focus contrast, including nested pane
activators. reduced motion removes transitions. segments have no enclosing track
border. labels wrap; equal columns remain the group layout.

`Tabs.tsx` exports one controlled `TabList`. supplied ids associate native tab
buttons with host-owned panels; left/right wrap and home/end select endpoints.
the callback owns selection commitment and guarded focus. tab refs remain native;
the primitive owns no panels, persistence or lifecycle. workspace pane controls
retain their toolbar semantics and management/drag behavior. their left in-view
tick is independent of the bottom active marker.

`Chip` is one native whole-label removal button with a decorative cross. it uses
shared action appearance and target minima; labels wrap. `AppliedFilters` owns
neighbor focus after removal and the caller's surviving-control destination.
query toolbars return to their input; stats returns to its modality select.

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
an explicit caller description owns complete spoken help; the tooltip supplies
a description only when none is provided. visual tooltip text stays independent.
disabled paint overrides every tone/selection state; focus stays visible.
forced colors use system colors; reduced motion stops color transitions and busy
rotation. colors, type and spacing use existing tokens; no geometry animation.

## overflow buttons

application action labels use sentence case in their owning producer, including
pending, recovery, inverse and disclosure states. named destinations retain their
names: Nexus, Lectern, All and Today. source titles, personal names and quoted
queries retain their literal spelling. shared action copy also names the same
inline controls; renderers never capitalize it.

command/link descriptors explicitly supply an icon. ordinary actions use their
semantic owner's glyph; only chapter and map destination lists use `null`.
the menu retains its 16px decorative slot and text label. custom content owns its
anatomy: swatches and status prose need no action glyph, while nested actions do.
empty and domain-state prose retain their own presentation. operational waiting
uses fixed controls; failures use the host recovery layer. icon-only button
contracts remain non-null. lucide owns standard
drawings; use existing semantic presentations or direct named glyph imports,
without a second registry, inferred glyphs or placeholders.

`OverflowMenuButton` is the named 16px/1.5-stroke ellipsis adapter over `Button`;
shared controls own its paint and busy glyph. it forwards native attributes,
handlers and refs without owning interaction state. `ActionMenu` supplies behavior and
aria bindings, not a visual class. semantic custom triggers own their appearance.
resource outlines compose relationship and resource verbs in this same menu;
their compact fine-pointer trigger is 24px and their coarse trigger 44×44px,
inside a reserved action column that never shifts content.

### index rows

index rows use the shared `ResourceRow` shell. its `indexRow` container owns
author and shortcut demotion, metadata spacing and tight-row adaptation; see the
[resource presentation contract](resource-references.md#presentation-contract).
hosts hide whole `data-action-control-key` wrappers; action components do not
infer placement from density. standalone preview controls retain their own layout.
external media rows expose the same more trigger at every width.

`CollectionView` callers explicitly declare `UniformIndex` capability before a
list larger than 200 can window. its two text lines share a measured vertical
slot across media, artwork and independent controls. rows without artwork or
controls reserve the same minimum height, and all rows use one narrow-width
fold threshold. width, font and control-size changes remeasure the actual
fractional border box; the full extent is count × measured height. a hidden,
inert canonical row supplies measurement while waiting remains in chrome.
ready rows are never clipped to enforce an estimated height.

`measuredIndexWindow.ts` owns the visible band, overscan and bounded interaction
pins; `collectionWindow.ts` shares pure rank arithmetic with the queue. the
complete source still owns matching, counts, summaries and commands. mounted
rows expose their full logical positions and set size; native browser find,
selection and accessibility traversal reach only mounted content. small lists
and intrinsic search, details and outline presentations keep their own layout.
the existing [pane memento](workspace.md#pane-history) owns scroll restoration.

outline styles own control minima: 24px with a fine pointer, 44px with any coarse
pointer. each control basis is the maximum of that minimum and one `--text-md`
glyph plus two `--space-1` gaps. leading/trailing slots, disclosure and spacers
share the basis in both dimensions; enlarged type can widen existing columns.
default geometry and nesting increments are unchanged. note-pane margins follow containing width,
bounded from 8px to 24px. reference carets reserve one control width at the text's
end for focus placement. nested search passages begin in the branch tail, without
also inheriting the parent body column's leading and trailing control gutters.
`OverflowMenuButton` declares sizing tokens; consumers do not
reach through its internal button markup.

`ResourceType` renders decorative, unfocusable, current-color lucide glyphs at
`--text-md` square with stroke 2. outline markers use muted ink at rest and retain
control hover/focus treatment; disabled opening markers remain readable in muted
ink. index prefixes use muted ink with a
`--space-1` gap; the glyph does not shrink, while the existing title fragment
ellipsizes. notes have no index prefix or gap. type adds no control or text line.

`ResourceRow`'s optional passive `leadingVisual` slot occupies a separate column across both text rows,
aligned at the top; expanded content starts at the text column. omitted visuals
reserve no gutter. podcast list artwork uses a fixed 44px square (`--size-xl`),
`--space-2` gap, `--radius-sm` corners and `--surface-2` background. containment
preserves the complete publisher image and can letterbox it. existing compact
title clamping, metadata ellipsis and status placement remain in force.

row defaults yield to each control's owned minimum target size. responsive
placement follows the resource presentation contract above.

mobile chrome/switchboard retain 48px and desktop nexus retains its wider
shortcut-bearing control through the same geometry contract.

## workspace strip

the desktop workspace strip keeps readable chips in its own horizontal
scrollport: the previous 12–15rem chip bounds grow by one 32px control width, or
44px when any pointer is coarse, preserving title space. each chip has three fixed, quiet slots:
visibility, layout, close. targets remain 32px within the 40px strip, or 44px
within 52px when any pointer is coarse. active fill,
in-view tick and minimized treatment remain distinct. keyboard focus reveals
only this strip. reduced motion removes displacement transitions; forced colors
retain selection and focus. controls use shared `Button` paint, tooltips and
decorative lucide icons: minus, square, overlapping windows and x. close is neutral.
`lib/workspace/paneControls.ts` owns content shared with manage-panes. mobile keeps
48px controls and wrapping titles. reorder completion uses one polite position
announcement; layout management emits no success toast.

## the lint

`lint:css-tokens` runs in `./scripts/test` after `build:shelf` and
`build:extension` and fails on a colour literal outside the owners above, or a
`var()` that resolves nowhere: not declared in any `src` css, not installed at
runtime (next/font variables, `--moon`, `--grain-seed`, measured geometry) and
without a fallback. the android shelf and the firefox popup load no hosted
stylesheet, so each built bundle is checked against its own declarations, where
next/font variables do not count (their packaged stacks must be declared).
