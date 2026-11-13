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
- `components/feedback/Feedback.tsx`: host provider, outcomes and mounted holds;
  `stage.ts` owns addressing and visible-time clocks, `Slips.tsx` owns placement,
  `Fact.tsx` and `Ruling.tsx` own in-flow facts and empty-region waits, and
  `Announcement.tsx` owns the short live region.
- `components/ui/*` except the overlay kernel's files ([overlays](overlays.md));
  `Field.module.css` is the one appearance of `Input`, `Textarea`, `Select` and
  `SelectField`.
- `lib/ui/{eventTarget,actionDescriptor,copyText,rovingIndex}.ts`.
- `lib/ui/icons.tsx`, the glyph lexicon.
- `scripts/check-css-tokens.mjs` (`bun run lint:css-tokens`) and
  `scripts/check-icons.ts` (`bun run lint:icons`).

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

native controls follow the nearest room's `color-scheme`: study is light; press,
solar and oracle are dark. the document's explicit room rule outranks generic
vendor `:root` defaults, independent of stylesheet load order. nested rooms retain
their own scheme.

## tokens

a module names `--danger`, never a colour. colour literals live only in
`globals.css`, `brand.css`, the reader theme (`documentReader.module.css`:
`::highlight` ignores `var()` on chromium and android webview ≤ 113) and the
oracle and atlas routes. shared defaults for scales, sans and mono faces,
spacing, motion, dimensions, focus metrics, highlights and shell geometry
live in a `:root`-only block before reduced-motion overrides. nested rooms inherit
them from the nearest ancestor, including overrides supplied by context owners.
the press block (`:root, [data-theme="dark"]`) declares only tokens another room
overrides: colour, shadow, grain, hairline, body size, tracking, serif face and
the section-title font role and modal scrim. `--overlay-scrim` is room-owned:
press `rgb(0 0 0 / 0.5)`, study `rgb(60 50 30 / 0.22)`, solar
`rgb(5 15 10 / 0.45)`. dialog, sheet, hover preview, share and nexus consume it;
`--overlay-scrim-soft` retains its shared default. text on an 18% tint of its own tone (`Pill`) reads
the tone's `--*-ink` step, which holds 4.5:1 over that tint.

the pane header's pointer role uses mono and machine ink in every room. the pending
source body publishes the role; the shell applies it only to a retained visit hint.
it changes neither the one heading nor the stored resource's canonical title.

## glyphs

`lib/ui/icons.tsx` is the lexicon and lucide's one importer. each export is one
sign: its name says the gloss, its trailing comment states it, and its drawing
changes there in one line. consumers write `import * as Icon from
"@/lib/ui/icons"` and name a sign: no named, computed or dynamic access. a new
export is paid for by a bare use. every sign is decorative, paints
`currentColor` and takes `className` and `size`; the slot owns size
(`--control-icon-size`, `.menuItemIcon`) and `control.tsx` owns waiting. a glyph
outside a slot sets `size` on the scale 12, 14, 16, 20, 24. domain
tables (the action catalog, `SCHEMES`, media kinds, `ROUTES`, destinations, nexus
rows, pane controls) choose a sign or `null`; presenters size and paint it.

1. a sign is a drawing plus one gloss. each determines the other.
2. a gloss reads true at every use, with the object taken from the label or the
   place. if it needs "or", the drawing is two signs.
3. a noun on a control means open or start that noun with this subject.
4. words are the default. a menu row paints a glyph only if that sign is read
   bare somewhere: alone on a control, as a type, or as a place.
5. no sign, no glyph. the slot stays and paints nothing. the label column never
   moves.
6. signs differ by silhouette at 16px. mirror images are for true inverses at one
   place.

a removal draws what survives it:

| paint | what survives | covers |
| --- | --- | --- |
| `Dismiss` | anything saved | close, clear a field, drop a draft, cancel a download |
| `Remove` | the thing; it leaves this place | remove from context or library, unlink, remove member, minimize a pane |
| `RemoveFromLectern` | the item; it leaves the Lectern | remove from Lectern |
| `Stop` | what is already done | stop response, stop playback |
| a word | not the thing itself | delete, remove from Nexus, remove download, remove import |

running anything again draws `Again`; replaying audio draws `Play`, because
pressing it plays. disclosure is `Disclose`; a select or picker draws `Choose`,
which does not turn. tucking collapses a notice in place, so its control draws
`Disclose` with its open state. declared exception: the library chooser's
indeterminate cell draws `Remove`'s minus. generation effort uses `Icon.Effort`.

every glyph keeps a 1.5px line (`--icon-stroke`) in screen pixels at any size:
`globals.css` sets the stroke width on `.lucide` and `vector-effect:
non-scaling-stroke` on its children, inside `:where()`, so the default weighs
specificity 0 and a glyph's own rule wins in any css chunk order. an exception
sets its weight in its own css and sets `vector-effect: none` on its paths, so
the weight stays in viewbox units, as the podcast subscription badge does. raw
`svg` and `strokeWidth` belong only to brand and data marks, in the owners
`eslint.config.mjs` lists.

## the solar's ornament

every ornament is a pseudo-element whose opacity is multiplied by `--ornament`
(1 Illuminated, .5 Whisper, 0 Bare), so at 0 nothing moves. a region demotes
its subtree with `calc(.5 * var(--ornament-root))`, never from `--ornament`
itself (a cycle). forced colours, `prefers-contrast: more` and print set the
dimmer and the grain to 0; tables, code and fields are Bare by construction.
ornaments stay in pane headers, resource rows, empty surfaces, the account
bookplate's rule, and the librarian's day rules and answer onset. the account's
solar-only eärendil star ends its rule. the day vine replaces its hairline with
the dimmer; the gutter leaf marks only a prose onset, never code or a table.
the two librarian sites do not use the moon. feedback uses the same restrained
anatomy in every room.

- **the moon slot law.** `--moon` (0.15 new to 1 full, set once per mount by
  `SolarEffects`) may enter only an opacity, a drop-shadow blur radius or the
  hue slot of an `oklch()`; never a lightness, chroma or colour. no contrast
  ratio may vary with the moon. review holds it (three uses, one module).
- **the tengwar law.** no tengwar webfont ships and no computed string is set in
  tengwar: inscriptions are baked outlines drawn as `aria-hidden` svg, the
  english beside them carries the meaning. review holds it.

## signals

feedback reserves no idle slot. a fact has one home, determined by its kind:

| fact | home |
| --- | --- |
| a press is running | its control's icon or kept-width label slot |
| no content yet | `Ruling` in the empty body |
| absent, empty, failed or gated object | `Fact`, or transport-aware `Failed`, where the object belongs |
| a durable fact over shown content | the object's existing status lane |
| refused input | `Field` beneath its input; send is the retry |
| refused command or ready result | plain slip; recovery also exists on the subject |
| unknown write outcome | mounted `Hold`; its owner retains the command |
| uncommitted words at risk | risk `Hold`, with the affected editor's danger caret |
| account condition | account mark and row; attention conditions speak once per onset |

selection, autosave, synchronization, successful refresh and refresh failure over
shown data are silent. failed reads heal through their read owner; a deliberate
press alone retries a write. copy keeps `useCopyFeedback`'s 1.2-second check and
one `copied` announcement. copy from a menu announces without a visible check.
long jobs keep their domain surfaces.

account name, calendar city and reading brief acknowledge an accepted explicit
save with ink settling from accent to ink over `--duration-deliberate`. each
module owns one keyframe, starts it with a data attribute and clears it on
`animationend`; no layout animates. the account and librarian settings bodies
use lowercase app copy while preserving names, addresses, cities and source
titles. destination names retain their registry spelling.

`PaneSurface measured` centres one 36rem column. only account and librarian
settings opt in; their sibling settings panes retain their existing layout.
email's read and edit boxes share a 36px minimum. a wrapping address remains
fully visible; entering edit snapshots that taller read height for the input.

date formatters return null when the browser cannot format the requested
zone. account settings omits those dates and shows the calendar city alone;
the write record retains server order without inventing day heads or times.

control busy is immediate in `aria-busy`, delayed 200ms in paint, then ramps for
200ms. settlement unmounts the spinner; a new subject remounts its control.
an iconless control hides its label at kept width. the control is one pointer
target, including its icon, label and spinner.

`Ruling` paints six static hairlines after 200ms, ramps for 600ms and shows
`still opening` at eight seconds. its active region says `opening` once at two
seconds. content replaces it immediately; headers show no waiting sign.
sequential empty reads of the same region carry their wait across a handoff;
a different source begins a new wait. old rows for a new query are inert at once
and dim to .6 only after the waiting delay.

`Line` is a fact and optional reason, visible together with at most two verbs.
copy is lowercase except user titles/names, at most fourteen words before title
interpolation, and states only what its owner can establish. interpolated product
labels remain fixed copy; shared transport reasons count toward the same limit.
`check` only reads;
a resend says `retry`. transport and account wording come from closed records.
request ids stay in the request log. there is no disclosure for a slip's reason
or verbs. desktop menus contain verbs, options and their own row marks. a picker's
empty list region may show its own fact, outside listbox markup; account conditions
belong only to the account menu.

`FeedbackProvider` requires the host's real `Shell`; a missing stage or shell
is a contract error. the authenticated workspace, share capture and shelf own
their respective sign-in operations. browser startup's modeled failure branch
mounts its own provider with its existing render environment and startup sign-in;
opening the authenticated workspace replaces that branch with the account's stage.
`stage.ts` defines addresses, `Line`, verbs and transport projection. `useOutcome`
and mounted `Hold` are the command owners' presentation interface. in-flow facts
and the standalone `Announcement` need no command stage.

`useResendFeedback` gives a retained remote write its current line and verbs.
the owner supplies the fact, exact resend and any secondary command. a stale
build keeps that fact, supplies the shared update reason, and offers reload
alone where it works; otherwise it offers no verb. sign-in keeps the shell's
link or command and its busy state. the hook presents admission; the domain
owner retains the intent and decides when it is resolved.

account-condition onset and local writing failure have separate owners. if a
local commit fails while a refused-sync notice remains visible, its old safety
claim withdraws without creating another condition onset; the writing-risk hold
and current account row retain their own facts.

one stage sits above command owners. a row addresses its invoking pane or the
workspace. fully visible panes have anchors; other pane addresses fall to the
root. phones and maximized layouts use the active pane. composers anchor above
their inputs; reader strips and shown mobile chrome contribute clearance.
root, pane and modal rooms place their notice frame and restore tab in disjoint
slots of one centered overlay group. the tab slot stays fixed through tuck and
restore, so the frame sits slightly off center but keeps its width and reachable
controls. the slots reserve no document space. root clearance measures actual
pane frames and tabs; standalone capture anchors to the page, outside its card.
a row raised under a modal belongs to that modal; unrelated rows wait.
risk always follows the topmost modal. modal geometry and its constrained-content
exception belong to [overlays](overlays.md#feedback-placement).

plain slips last five visible unheld seconds, eight with a verb. a new plain
line replaces the standing plain line unless a pointer, focus or press holds it;
then it stacks. newest lands above older rows without moving them. at rest the
frame shows three rows before internal scrolling. a held frame may grow above
that cap to preserve the controls under the hand.

`Hold.id` identifies a fact across component holders; `attempt` identifies a
failed retry for speech. the earliest mounted holder supplies its pane. a 100ms
handoff preserves a row while its holder moves between commits. an unmounted
last holder resolves it; changing an existing holder's id resolves the old id
immediately. tucking changes presentation only. the tab retains no command,
draft, history or loss guard and disappears when its owners resolve.

typing ghosts a standing slip and stops its clock; new ordinary slips wait for
the pause, at most eight seconds. risk does not wait. eligible shown slips speak
through the root announcement pair, or the topmost modal's pair while it is open;
a fully visible inactive pane's slip remains eligible. in-flow facts and fields
speak only in the topmost modal, else the active pane or standalone host. short
facts and reasons enter the live region, never controls; risk is assertive and
other lines polite.
appearance takes no focus. a withdrawing verb restores only focus it owns.
a changed command keeps the former control disabled while pointer or keyboard
focus holds it. its replacement appears in that position only after both leave.
the running head's up link is the explicit exception: its command stays one step
up the structure, so a second press goes from the current section's start to the
previous section without waiting for the pointer to leave.
`mod+.` reaches the first slip control; escape closes or tucks and returns focus.
coarse-pointer downward swipe dismisses plain rows and tucks held rows when
the frame fits. an overflowing frame uses native scrolling; its visible close
and tuck controls remain available.
reduced motion removes movement; forced colours retain borders and ticks.

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
primitive declares. `PaneHeaderIdentity` reads `--pane-title-ink` (default `--ink`);
`SurfaceHeader` reads `--pane-header-rule-ink` (default `--edge-subtle`).
pane query/navigation controls share declared density
tokens owned by `CompactChrome.module.css`, applied to pane control rows,
companion headers, workspace strips, connections controls and the page's running
head. `--pane-control-row-padding-block` pads pane control rows; the page head
and pane view/section rows set it to zero. the head consumes it to place the section gauge on the host
row's bottom edge. targets grow with
content, with 32px fine-pointer and 44px any-coarse-pointer minima. chrome stays
13px; coarse text-entry/native-select values use 16px. the two type roles are
independent. non-pane field defaults remain unchanged. `SelectField`'s `Inline` layout owns the label and
native intrinsic value width; the whole control wraps before its label stacks.
`Stacked` forms keep their layout.

content in a companion beside a text is a third type role. a `Column` or `Sheet`
companion and inline librarian figure host apply `[data-type-role="margin"]`
from `globals.css`, setting `--content-font-size` 13px, `--content-meta-font-size` 12px and
`--content-line-height` `--leading-snug` on its contents, and `--excerpt-scale`
`.875` and `--excerpt-max-size` `--text-md` for quotes ([highlight](highlight.md)). a `FullScreen`
companion replaces the text, so it is a page and sets none. resource outline rows,
ordinary note bodies and page titles read the tokens with their own sizes as fallback. passive figures set no room or density. librarian figures inherit the surrounding
room; dark rooms use the reader's dark highlight inks, light rooms retain their inks. notes
outside a companion use one 14px/1.5 type; chrome and targets never read these tokens.

`PaneQueryToolbar` groups controls by pane width. its boxed input always reserves
the clear slot, so typing/clearing preserves the input's bounds and node.
applied text, chips, visible status and reset wrap in one compact summary;
errors and expanded options share its bounded refinement region. shell
measurement publishes the cap. essential controls never depend on horizontal
scrolling. [workspace controls](workspace.md) own capability, find and focus
behavior; this module owns toolbar presentation. historical browser qualification
in #628 included native firefox 158 page/text zoom at 200% in a 320px pane;
it makes no spoken assistive-technology claim.

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
`ResourceListHead` supplies nonsticky presentation list items with an `h3` and optional verbs; collection heads forbid windowed geometry.
the armed `Collection` row is `--surface-2` plus a 2px leading inset
`--accent` bar, app-wide. forced colours replace that shadow with a `Highlight`
outline. arming has no transition. literal `ResourceContent` matches underline
in the accent at the room's hairline thickness, without changing font weight.

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

## nexus palette

`Nexus.module.css` owns desktop arrangement; `Switchboard.module.css` owns
the sheet, mobile page frames and disc. selection paint remains in `Collection`,
match paint in `ResourceContent`, scrims in the room blocks.

both surfaces use one 40px gutter; caret and titles share its x. palette glyphs
are 16px with the registry’s shared 1.5px stroke. titles are sans 15px/400 in press and study, serif 18px/500 in
solar. heads, facts and hints use `--ink-muted`. rows have square corners and
one title plus at most one supplement; the resource identity never changes
weight when matched or armed.

the desktop card is at most 640px wide, on `--surface-canvas`, with a 48px
query and 36px ordinary rows (44px for coarse pointers). typed holds 70dvh with
a fixed continuation footer; arrivals consume the result scrollport above it.
blank remains content-sized within that cap. the sheet has 48px row/control
targets and a horizontally scrolling inline rail, with no key hints. rank one
touches the bottom field; dom order is rank order, painted bottom-up. group heads
are last in their reversed groups and retain accessible group labels.

desktop open uses 120ms bloom: opacity .7→1, scale .985→1 and y −4→0;
scrim fades over the same interval. close is instant. arriving rows use a 200ms
opacity onset; held rows do not animate. rail open uses 100ms glide and 4px
travel; rail focus paints immediately. `MobileSheet` owns its 220ms transform.
reduced motion removes these animations; forced colours retain boundaries and
the armed outline. disc swipes show a destination/clamp chip for 600ms without
animation. the [release record](../issues/release-palette.md) owns glyph and
feedback handoff debt.

## choice controls

selection has three drawings. a place among peers uses the lit rule: lowercase
words on the host's inset hairline, the current word in `--ink` and semibold,
and one square-ended 2px `--accent` mark covering its stretch of the rule.
a value among options uses a raised thumb in a sunken track. an independent
switch retains `Control.module.css`'s pressed tint. the nav rail's place tint is
the standing exception. the armed list row keeps `Collection`'s paint; an armed
nexus verb takes an enabled fill, without a mark.

tab words reserve their heavier width at rest. neither tabs nor pane chips have
a resting fill. hover brings ink and a hairline ghost under the word. only the
mark and thumb transition between choices; first placement and reduced motion
are immediate. the solar overlays the mark's accent with its ornament-gated
brass. forced colours use `Highlight` for the mark, `CanvasText` for the pane
bracket, and `Highlight`/`HighlightText` for the thumb and chosen word.

`useIndicator(host, key)` owns geometry, not selection or paint. a relative host
renders one decorative `[data-indicator]` and at most one `[data-indicated]`
child. the hook measures in host scroll coordinates, watches the host and
children's sizes and child replacement, and writes `--indicator-start` and
`--indicator-size`. consumers read both with `0px` defaults; the first measured
placement precedes `data-indicator-ready` and enables later transitions.

`Tabs.tsx` owns controlled `TabList` and route `TabLinks`. tab items supply
string labels, ids, panel ids and optional native refs. arrows wrap and home/end
select endpoints; the host commits selection and guarded focus. choosing the
current tab does nothing. no matching value leaves no mark/current tab, with
the first tab reachable. the primitive owns no panel lifetime. route sections
are anchors with `aria-current="page"`; the pane's anchor owner follows or forks.
tab-row hosts draw their hairline inside the box, give no block-end padding,
and keep the mark at block-end. no outside border is clipped by a scroller.

an exclusive choice shown as its options is `RadioGroup`: a native fieldset
named by its legend, one shared radio name and an optional group description.
`Inline` keeps native checked marks. `Segmented` and a desktop menu's
`menuitemradio` row share `Segments`: content-width options in one sunken track
with a raised `--surface-2`/`--shadow-1` piece. segments own their targets, focus,
disabled and forced-colour paint; native inputs cover only their own label and
retain native radio keys. labels may be nodes, including a font in its own face.
menu activation and keyboard semantics remain with `ActionMenu`.

`ChoiceField` owns native label/input geometry and group layouts. names reference
label-only spans; descriptions and tooltip help remain separate; refs address
the input. its `Facet` is a native checkbox with a glyph and short label. checked
is quiet; unchecked dims and slashes the glyph, leaving the word legible.
facets own hover fill, target, focus, disabled and forced-colour rules; forced
colours keep only the unchecked slash. independent switches use control tint.
all these targets are at least 32px fine and 44px with any coarse pointer.

choice lists use `Collection`'s separate active and selected states, selected
checkmark and visible unavailable reasons. labels wrap; bounded lists scroll
vertically. status and refresh content sits outside listboxes. command menus and
library membership retain their own semantics;
[overlays](overlays.md#surfaces) owns the responsive picker shell. chat's single
generation control, provider sections and effort region belong to
[chat](chat.md#generation-selection).

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
quiet-only `tone="accent"` marks a writing instrument's commitment with semibold
accent ink and an accent-muted hover ground. `tone="danger"` marks destruction
independently. disabled paint wins over both tones. `size="comfortable"` has a 44px
minimum; compact controls use their host minimum or 32px. any coarse pointer
enforces at least 44px in both axes, except for controls inside authored outline
rows, which follow the row geometry below. the existing dense outline exception
is 24px with fine input; mobile headers remain 48px. geometry hooks are
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
rotation. colors, type and spacing use existing tokens; no layout animation; a
state glyph may animate its own stroke weight. a turn is glyph-internal:
`Disclose` turns its own chevron by state; no owner rotates a glyph or swaps one
to show open state.

## overflow buttons

application action labels use sentence case in their owning producer, including
pending, recovery, inverse and disclosure states. named destinations retain their
names: Nexus, Lectern, All and Today. source titles, personal names and quoted
queries retain their literal spelling. shared action copy also names the same
inline controls; renderers never capitalize it.

command/link descriptors carry a sign or `null`, as their domain table chooses
under [the glyph laws](#glyphs). the menu retains its 16px decorative slot and
text label; a `null` row leaves the slot blank, so labels share one x. custom
content owns its anatomy: swatches and status prose need no action glyph.
empty and domain-state prose retain their own presentation. operational waiting
uses its existing controls; command failures speak at the invoking pane. icon-only button
contracts remain non-null. lucide is reached only through `lib/ui/icons.tsx`;
no inferred glyphs or placeholders.

`OverflowMenuButton` is the named 16px/1.5-stroke ellipsis adapter over `Button`;
shared controls own its paint and busy glyph. it forwards native attributes,
handlers and refs without owning interaction state. `ActionMenu` supplies behavior and
aria bindings, not a visual class. semantic custom triggers own their appearance.
resource outlines compose relationship and resource verbs in this same menu;
their compact fine-pointer trigger is 24px and their coarse trigger 44×44px,
at the top of the row's right column; the trigger never shifts content.

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
pointer. each resource-outline control basis is the maximum of that minimum and
one `--text-md` glyph plus two `--space-1` gaps; enlarged type can widen existing
columns. `ResourceOutlineRow`'s control column and text measure belong to its
[anatomy](resource-references.md#controls-and-composition).
authored outline rows instead size their controls to the line, in 25px rows with
a fine pointer and 32px rows with any coarse pointer, where the 28px bullet spans
its row and no disclose slot is drawn. their type remains 14px fine / 16px coarse
at 1.5 line height, including inside a companion. an embedded resource row keeps
its controls inline at the far end of the authored row. its existing control
minima may make that row taller than a plain authored row; usable controls take
precedence over equal row heights.
note-pane margins follow containing width,
bounded from 8px to 24px. reference carets reserve one control width at the text's
end for focus placement. nested search passages begin in the branch tail, without
also inheriting the parent body column's leading and trailing control gutters.
`OverflowMenuButton` declares sizing tokens; consumers do not
reach through its internal button markup.

`ResourceType` renders the sign `lib/resources/type.ts` chooses for its type (a
held media kind's medium, else its scheme's; see the
[presentation contract](resource-references.md#presentation-contract)),
decorative, unfocusable and current-color, at `--text-md` square. outline markers use muted ink at rest and retain
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

the desktop strip is a 40px toolbar, 52px with any coarse pointer. its scroller
owns content-sized chips and the shared lit mark; an end group owns minimize
and layout for the active pane. chips have a 16px sign, the user's verbatim
title and one held close target. widths grow equally from 6.5rem toward each
content width, capped at 12.5rem; below the floors only the strip scrolls.
close retains a 32/44px target, revealed on active, hover or focus-within chips;
an inactive close takes no pointer events at rest without losing its slot.

one faint bracket under each chip maps its pane wrap's on-screen fraction,
companion included, with 5px outer ticks. minimized chips have no bracket;
maximized mode gives only the active chip a full bracket. minimized titles stay
`--ink-muted` and wear a dashed underline with their sign lowered 2px, so they
remain distinct from off-screen visible panes without disabled ink. reciprocal
chip/header brushing projects through dom attributes and declared header tokens,
without react pointer state. canvas selection dims only inactive pane titles;
controls retain their ink and pointer-role titles keep their own. only forced
colours retain the active pane's top hairline.

`activePaneControls` owns active minimize/layout content. minimize uses `Remove`,
maximize `Maximize`, restore `Restore`, close `Dismiss`. end-control identity
survives active-pane changes and keeps focus. successful minimize says
`minimized {title}.` in the strip's polite status; last-visible refusal explains
`keep at least one pane visible`. reorder announces position once. the nexus
pane list retains its independent wrapping titles and 48px close targets.

## the lint

`lint:css-tokens` runs in `./scripts/test` after `build:shelf` and
`build:extension` and fails on a colour literal outside the owners above, or a
`var()` that resolves nowhere: not declared in any `src` css, not installed at
runtime (next/font variables, `--moon`, `--grain-seed`, measured geometry) and
without a fallback. the android shelf and the firefox popup load no hosted
stylesheet, so each built bundle is checked against its own declarations, where
next/font variables do not count (their packaged stacks must be declared).

`lint:icons` runs beside it and fails when two registry exports are one drawing,
compared by value, since lucide exports each drawing under several names (`X`,
`XIcon`). eslint fails on a lucide import outside the registry (`lucide-react` or
any subpath), a registry import other than `* as Icon`, computed `Icon[name]`, a
dynamic glyph import, raw `svg` or `strokeWidth` outside their owners, and a
capitalised literal as a `fail` title or `say` fact, sparing only a compound PascalCase `fail` kind tag
(`"SourceChanged"`). flat config replaces a rule's options per block, so a block
that restricts imports or syntax for its own files spreads the shared lists.
