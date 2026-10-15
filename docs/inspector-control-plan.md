# inspector control implementation plan

status: implemented; local qualification passed with recorded device and
assistive-technology limits. disposable resources deleted; final static gate
passed. normal post-release smoke remains.
origin: 2026-10-14; surveyed baseline `367da80e0`.

recover pane-title space with an icon-only inspector control. preserve its
meaning, discoverability and existing inspector behavior. approved boundaries:
inspector only; disposable tests against an isolated local stack, followed by
a small production smoke check of the released candidate.

## target behavior and content

the product designer owns both the control and its explanatory copy. good
content identifies the existing capability, expresses the next action, and
adds no terminology. reuse the descriptor; do not create a content registry.

| element | required final state |
| --- | --- |
| control | existing rightmost position after more; stable `PanelRight`, 20px, decorative; no visible label |
| target | desktop 32×32px; 44×44px under `any-pointer: coarse`; existing mobile 48×48px |
| name | `Inspector`, from `companion.label`; explicit `aria-label` on both buttons |
| help | `Show inspector` collapsed; `Hide inspector` expanded; from `companionState.menuLabel` |
| semantics | native button; preserve `aria-expanded`; `aria-controls` only names the mounted inspector; no `aria-pressed` for this disclosure |
| appearance | preserve selected background, ink and focus ring; existing theme tokens; no new accent, badge or animation |
| content shape | one plain-text action phrase; no heading, link, shortcut, rich content or per-route synonym |

the workspace store retains durable visibility, tab and width; the companion
controller owns commands and focus return. find results occupying the secondary
region do not mean the durable inspector is expanded. activating the trigger
restores its remembered/default tab. preserve query, reading position and mobile
sheet behavior.

## tooltip interaction contract

- mouse or hovering pen opens help after 500ms of uninterrupted trigger hover;
  keyboard `:focus-visible` opens it immediately, including on mobile layouts.
  touch activation operates the inspector without opening help.
- keep help visible while the pointer is over trigger/help or keyboard focus
  remains on the trigger. leaving both pointer areas closes after 150ms unless
  keyboard focus retains it. blur closes when no pointer engagement remains.
  a removed help surface no longer counts as pointer engagement.
  leaving during the opening delay cancels it immediately. no automatic expiry.
- trigger pointerdown/activation, outside press, escape, window blur, unmount
  or an interactive overlay appearing cancels pending work and closes help.
  activation still runs exactly once. dismissal defeats sustained hover/focus
  and text changes.
  only a new trigger entry or focus-visible entry can rearm; removing an
  overlay alone cannot reopen help.
- help never moves or restores focus, traps tab, blocks ordinary commands,
  creates history or consumes back. escape dismisses the newest eligible hint
  before the focused inspector handles that key; it changes nothing else.
  an interactive menu/modal retains priority and suppresses inspector help.
- use a unique `useId` id, `role="tooltip"` and `aria-describedby` only while
  help is rendered. no live region, focusable descendants or duplicate native
  `title`.
- position below/end, flip above when necessary, clamp to safe viewport bounds.
  provide 8px visual separation with a contiguous transparent hover corridor:
  anchor gap zero, 8px padding on the wrapper's anchor-facing side. a timer
  alone does not support slow pointer travel. the corridor captures only that
  gap, not surrounding controls.
- use `--text-sm`, `--leading-snug`, `--ink`, `--surface-2`, `--edge` and
  `--radius-sm`; text padding 4px vertically/8px horizontally. cap the inner
  caption at 16rem and available width: positioning writes the outer box's
  inline viewport maximum. wrap without ellipsis; no arrow. forced colors use
  `Canvas`/`CanvasText` for surface/text/border with default color adjustment.

the hover contract follows [wcag hover/focus guidance](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html).
button state follows the [disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/).
the [aria tooltip pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/)
supports the role/description relationship but remains a work in progress.
the dimensions and delays above are product choices.

## ownership and capability contracts

composition: `companionAction` → existing action-state projection → desktop or
mobile button inside `Tooltip` → existing positioning and overlay kernel.
no backend, wire, database, persistence or descriptor schema changes.

```tsx
type TooltipProps = {
  text: string;
  renderTrigger: (props: TooltipTriggerProps) => ReactElement;
};
```

`TooltipTriggerProps` contains `ref: Ref<HTMLButtonElement>`,
`"aria-describedby": string | undefined`, and native-button handlers for
`onPointerEnter`, `onPointerLeave`, `onPointerDown`, `onFocus`, `onBlur`,
`onClickCapture`. callers spread these onto the actual button. the caller owns
`onClick`, accessible name, disclosure attributes and styling. click capture
closes help before the existing command; ordinary activation is never prevented.

`Tooltip.tsx` owns engagement, timers, dismissal and description linkage.
use one internal phase: closed, pending or visible. register with `useOverlay`
while pending or visible; tooltip `eligible()` reports visible. pending help
has no rendered surface or description. escape cancels it without taking the key.
reuse `useAnchoredPosition`, `useOverlayContainer` and `useOverlay`; portal the
surface, not a wrapper around the trigger. stop mousedown/click propagation
from the tooltip surface so react portal bubbling cannot start header dragging
or activate a pane. preserve text selection; do not prevent those defaults.
clear pending timers on close/unmount. no cloning, ref-merger framework,
provider, configurable delays/placement, controlled-open API or touch sheet.

`overlay.ts` owns arbitration. an ordinary `transient` is WRONG here:
`owner()` also controls command suppression, and `PaneShell` yields pane find
while `hasActiveInteractionOwner()` is true. implement these narrow changes:

1. extend `OverlayOptions` with explicit `kind: "tooltip"`, dismissal,
   inside boxes and required `eligible()`. its type must exclude command scope
   and return-focus options. retain modal/transient behavior.
2. exclude tooltips from interactive `owner()`, back, history and opener/focus
   jobs. keep the single stack; do not introduce generic capability flags.
3. export `useHasActiveInteractionOwner(): boolean` using
   `useSyncExternalStore(subscribe, hasActiveInteractionOwner, () => false)`.
   preserve `useOverlay`'s existing return shape and snapshot granularity.
   the tooltip subscribes while closed to cancel pending hover on owner entry,
   and checks the imperative query again when its opening timer fires.
4. add one tooltip-only document capture listener for escape. ignore already
   prevented/composing events. snapshot interaction ownership; cancel every
   pending tooltip across scopes without consuming the key. if no interactive
   owner existed, dismiss only the newest visible eligible tooltip in the
   current modal scope, preventing default and stopping propagation only for
   that dismissal. preserve modal/transient bubble handling. capture is necessary
   because `Companion` handles escape before the existing bubble listener.
5. outside presses may dismiss tooltips but must neither set the scrim
   algorithm's `closed` flag nor stop its search at a tooltip's inside box.
   a hint cannot consume the press intended for another control or scrim.

render help only in the visible phase, uncovered and free of an interactive owner;
close on suppression, rather than retaining hidden state that later resurfaces.
no separate registry, singleton-tooltip policy or per-tooltip document listener.

## implementation boundaries

source paths below are relative to `apps/web/src/`; documentation paths are
relative to the repository. each owner edits only its row; review contracts
before dependent work begins.

| owner | files and responsibility |
| --- | --- |
| overlay engineer | `lib/ui/overlay.ts`: passive tooltip policy and subscription; `docs/modules/overlays.md`: resulting contract |
| ui engineer and content designer | new `components/ui/Tooltip.tsx`, `Tooltip.module.css`: interaction, rendering and copy schema above |
| inspector engineer and content designer | `components/ui/SurfaceHeader.tsx`, `SurfaceHeader.module.css`, `components/appnav/MobilePaneBar.tsx`, `components/workspace/Companion.tsx`: integrate help, icon and targets; `docs/modules/workspace.md`: resulting contract |
| independent qualifier | external disposable runner; `docs/inspector-control-verification.md`: sanitized evidence and limits |

dependency order: overlay → tooltip → inspector integration. write and review
the behavior oracles before implementation. the designer rejects visual/copy
drift; the accessibility reviewer rejects changed command, focus or history
behavior; the architecture reviewer rejects duplicated state and unnecessary APIs.

reuse `Button`'s `iconOnly` form. header css must own both dimensions: merely
setting `iconOnly` produces 28px width against the existing 32px height. use
existing size tokens locally; do not change global button sizes. keep mobile's
existing 48px style. update the shared descriptor's glyph once.

hard cutover: remove the visible caption, native title, obsolete sizing rule
and labelled-desktop comments/contracts together. retain the semantic name.
no flags, duplicate render paths, compatibility layer or native-title fallback.
delete newly orphaned code only after checking its callers.

## acceptance and disposable qualification

use one isolated account/profile and one real structured article or epub with
a long title, at least two headings and repeated searchable text. exercise
browser → web/bff → api → isolated data through normal auth and public flows;
run the normal worker only if fixture preparation needs it. no mocks, auth
bypass, test-only production seams or fabricated workflow rows.

| id | observable acceptance |
| --- | --- |
| 1 | no visible caption; 20px glyph and 32/44/48px targets; correct name, expanded state and mounted-region reference; no lost controls in a 320px pane with a long title |
| 2 | tab reaches trigger; enter/space each toggle once; no canvas drag; existing desktop focus policy; closing from inside restores the exact invoking trigger |
| 3 | hover/focus timing, slow corridor crossing and persistence work; escape during the opening delay cancels help and reaches the focused component; visible-help escape/activation suppress reopening until fresh engagement; touch produces no help; no native title or timer surviving unmount |
| 4 | help leaves pane find/navigation and focus unchanged; after two ordinary history entries, hover help and verify one browser back reaches the preceding entry; with focus inside inspector, first escape dismisses visible help, second follows existing behavior; newer menu/modal wins; first scrim press works; composition is not intercepted |
| 5 | real find results replace durable inspector correctly; trigger restores remembered/default tab without losing query or creating another region/sheet; no stranded help |
| 6 | touch opens one mobile sheet; selected tab receives focus; close/escape/back preserve focus return and reading position; desktop/mobile transition leaves correct target and no stranded help; external keyboard can reveal help |
| 7 | designer approves normal/hover/open/focus in all three themes, forced colors and actual 200% browser zoom; unclipped help, visible icon/focus ring; exposed name/state and actual focus verified separately from screenshots |

in case 3, distinguish a canceled timer from legitimate new focus after the
focused component handles escape: focus restoration may rearm help.

full matrix in chromium; repeat pointer travel, escape ordering, focus return
and narrow-layout geometry in firefox/webkit, plus mobile touch where supported.
read back the actual `any-pointer: coarse` media-query result before geometry
checks; no css or `matchMedia` overrides. a touch-capable context alone is not
proof. one brief real screen-reader check records name/state and available help,
without duplicate native-title/live-region announcements; if unavailable, record
that limit. browser semantics do not establish spoken output.

1. record baseline source identity, including unrelated dirty inputs. build a
   pinned runner under `/tmp/nexus-inspector-<nonce>/`, with explicit isolated
   ports/config and an ownership manifest for processes, data and dependencies.
   never inherit ambient `.env`/`.dev-ports` or attach to shared services.
2. independently review assertions; run red. caption/glyph/coarse sizing and
   absent custom help are target failures. classify preservation passes,
   unrelated failures and setup blockers honestly; missing help is one red,
   not several invented downstream failures.
3. implement by the ownership boundaries. review each completed boundary against
   its invariants before integration; run the same assertions green. review
   adversarially, refactor, rerun affected journeys and `./scripts/test`.
4. retain sanitized source/build identities, engine versions, results, selected
   before/after screenshots, material limits and cleanup in the verification
   document. delete only manifest-owned tests, runner dependencies, profiles,
   fixture data/accounts, processes and volumes. rerun `./scripts/test`.
5. after normal deployment of that qualified candidate, smoke existing
   production content: open/close, keyboard/help, mobile dismissal and one
   find-results switch. restore prior workspace state. no fault injection or
   production test content. an old build cannot qualify the candidate.

this is the user's explicit disposable-test exception to
[local testing standards](local-rules/testing-standards.md); retain no suite,
test dependency or production seam, and change neither `./scripts/test` nor ci.
deletion forfeits repeatable automated regression coverage; retain the behavior
contract and run receipt. record unfixed findings in `docs/tickets/` and its
register. close the inspector ticket only after implementation and qualification.

## scope and tradeoffs

- icon-only presentation recovers title space but reduces immediate discovery;
  stable position, clearer glyph and keyboard/hover help carry the meaning.
- coarse desktop targets cost 12px more width; choose touch accuracy. the 500ms
  hover delay reduces incidental help at the cost of slower discovery.
- accessible custom help requires a small component and kernel change; reuse
  geometry/arbitration instead of another dependency or parallel overlay system.
  normal focus restoration may show help again; accept that repetition without
  adding focus-origin tracking.
- navigation tooltip repair stayed separate and was resolved by
  [pr #625](navbar-launcher-verification.md). do not migrate `HoverPreview`,
  other icon controls, reader shortcuts or unrelated overlay behavior.
- no inspector content redesign, replacement state model, new shortcut, global
  icon registry, theme overhaul, telemetry, backend work or deployment changes.
  narrow cross-browser repetition limits cost; record actual device/assistive
  technology gaps without claiming coverage.
