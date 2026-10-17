# action menu button plan

status: complete; [qualification and limits](action-menu-button-verification.md).
origin: 2026-10-14; approved quiet-square direction and button-only scope.
surveyed baseline: `367da80e0c1beb1c426f6d2d72201b0733809b50`.
review: independent interaction/content, architecture and verification reviewers.

## goal and boundary

make every ellipsis menu trigger deliberate, consistent and visibly engaged
while open. preserve menu contents, commands, positioning and interaction.
this is one presentation feature; no backend, wire, database, persistence,
action-descriptor or capability-policy schema changes.

in scope: the `ActionMenu` default and six custom overflow renderers:
`SurfaceHeader`, `CollectionRow`, `MobilePaneBar`, `DesktopNexus`,
`SwitchboardTask` rows and `SelectionDock`.

excluded: command promotions; menu surface/item redesign; new tooltips;
account/avatar, zoom and relationship-removal controls; anchored menus without
triggers; drag redesign; new shortcuts; theme overhaul; deployment work.
menu Tab behavior, inverse-command semantics and disabled explanations were
separate from that historical cutover; they are now resolved by
[principal actions](principal-actions-verification.md). the historical
[firefox selection-dock finding](tickets/firefox-selection-dock-closes-when-its-menu-takes-focus.md)
and [drag work](index-reordering-plan.md#5-interaction-and-content) retain their
own source/qualification history.

## target appearance and content

the interaction/content designer owns the glyph, adornment fit and semantic
copy review. good content identifies the existing action without new vocabulary:
retain each accessible name, disabled explanation, menu label, status marker,
keyboard hint and existing selection-dock title. add no visible caption,
tooltip, chevron or `aria-pressed`. the decorative glyph has `aria-hidden`.

| state | background | foreground | 1px border |
| --- | --- | --- | --- |
| rest | transparent | `--ink-muted` | `--edge` |
| enabled hover | `--surface-hover` | `--ink` | `--edge` |
| enabled press or open | `--surface-active` | `--ink` | `--ink-muted` |
| native or aria-disabled | transparent | `--ink-faint` | `--edge` |

- use lucide `Ellipsis`, 18px, stroke width 1.75, centered; `--radius-md`
  (6px). one implementation owns the glyph and paint. no font ellipsis.
- default minimum target: `--size-md` (32px) each axis; `--size-xl` (44px)
  under `any-pointer: coarse`. zero default padding, border-box sizing,
  inline flex, centered contents, no shrinking; button anchors its adornments.
- preserve mobile header and switchboard 48px targets; selection dock is 32px
  desktop and at least 44px when its existing `isMobile` flag is true.
- nexus keeps its whole shortcut-bearing button: minimum 76px width, 64px
  under its existing `max-width: 640px` or coarse-primary-pointer rule; existing
  padding, gap and hint-before-icon order. do not nest another button or move
  the hint outside the target. height follows the shared 32/44px minimum.
- disabled overrides every paint state and uses the default cursor; suppress
  enabled hover/press treatment. no whole-button opacity that dims badges.
  otherwise open/pressed outrank hover. press and open intentionally share paint.
- focus is additive, including focusable aria-disabled buttons: inset outline
  of `--focus-ring-width` in `--ring`, offset `-1 * --focus-ring-offset`.
  preserve native-disabled versus aria-disabled focus/activation semantics.
- transition only foreground, background and border colors using
  `--duration-fast`/`--ease-glide` (150ms); existing reduced-motion tokens zero
  duration. no translation, scaling, rotation, shadow or geometry animation.
- forced colors: closed uses `Canvas`/`ButtonText`; engaged uses
  `Highlight`/`HighlightText`, with `forced-color-adjust: none` on that pair;
  disabled uses `Canvas`/`GrayText`. borders use the foreground. focus follows
  effective paint: enabled engaged uses `HighlightText`; closed or disabled
  uses `Highlight`. disabled wins even when `aria-expanded` remains true.
- status badges remain absolute, noninteractive and decorative. preserve their
  apparent corner position; neither badge nor hint may displace the glyph
  unexpectedly. state changes never move the button, row, title or neighbors.

use existing tokens in all three rooms and any applicable oracle scope. the enabled icon
and focus indicator must contrast at least 3:1 against their actual background;
the keyboard hint requires 4.5:1. the faint resting border is supplementary,
not the sole identifying cue ([non-text contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)).
32/44/48px geometry and paint values above are product decisions.

## architecture and capability contract

composition: existing action descriptors → existing menu/runtime/overlay →
native trigger bindings → `OverflowMenuButton` or a semantic custom trigger.
`ActionMenu` owns opening, focus, dismissal and dispatch to existing descriptors;
the existing runtime owns command execution. derive paint from native pseudo-
classes, `aria-expanded` and disabled attributes; add no interaction state.

add `components/ui/OverflowMenuButton.tsx` and its css module:

```tsx
type OverflowMenuButtonProps = Omit<ComponentProps<"button">, "type">;
```

one native `button`; apply fixed `type="button"` after spreading native props,
and remove redundant explicit `type` from migrated callers. pass through
handlers, attributes and the react 19 ref. merge its class with `className`. render
`children` before the fixed glyph: this slot holds only existing noninteractive
`kbd` or absolute status adornments. it owns no state, event interception,
menu policy, loading policy or overlay. no variants, icon registry, provider,
slot framework or changes to generic `Button`.

remove `className` from `ActionMenuTriggerProps` and the generated binding
object. remove overflow trigger css from `ActionMenu.module.css`; default
rendering uses `OverflowMenuButton`. keep `renderTrigger`, `triggerRef`,
`triggerAttributes` and all other contracts. `ActionMenu.className` still
styles its container. resource wrappers infer the revised type without new props.

custom overflow renderers spread the bindings onto `OverflowMenuButton`,
retaining their existing handler composition verbatim. preserve collection
drag listeners/click suppression/alt-arrow handling; nexus refs, tab exclusion,
selection hooks and shortcut; mobile pane marker; selection-dock native disabled.
preserve names, descriptions, ids, `aria-haspopup="menu"`, `aria-expanded` and
the mounted menu's `aria-controls` relationship
([menu-button contract](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/)).

consumer css owns geometry/adornments only. use owner-qualified selectors such
as `.actionsCell .actionsButton` for geometry exceptions, so they outrank the
shared single-class minimum without depending on import order. use minimum
sizes; never fix the compound button's width around text. do not also add
size-variable or variant APIs. mobile overflow gets a geometry-only class;
do not retain `.topBarButton` paint or `.rowMenu` paint/hover selectors on it.
use `min-inline-size` consistently and qualify both nexus width rules identically.
remove its local 32px height rule so it cannot defeat the shared coarse minimum.

`ContextEdgeMenu` currently depends on the inherited trigger class. move that
distinct control's current appearance unchanged into its own css module and
apply it explicitly. account and zoom already supply their own classes.
this preserves current semantic controls while removing implicit styling from
behavior bindings. do not introduce a second overflow implementation.

## work boundaries and files

source paths below are relative to `apps/web/src/`; documentation paths are
relative to the checkout. each row has one implementer; the same designer
reviews every consumer. no parallel ownership of a file.

| owner | files and responsibility |
| --- | --- |
| shared ui engineer | new `components/ui/OverflowMenuButton.{tsx,module.css}`; `components/ui/ActionMenu.{tsx,module.css}`; `components/resources/ContextEdgeMenu.tsx` and new `ContextEdgeMenu.module.css` alongside it: presentation/binding split and semantic-control preservation |
| pane/list engineer | `components/ui/SurfaceHeader.tsx` and its css if badge placement needs adjustment; `components/collections/CollectionRow.tsx`; `components/appnav/MobilePaneBar.tsx`, `components/appnav/AppNav.module.css`: adopt primitive, retain events, isolate mobile geometry |
| nexus/reader engineer | `components/nexus/desktop/DesktopNexus.tsx`, `components/nexus/Nexus.module.css`, `components/switchboard/SwitchboardTask.tsx`, `app/(authenticated)/media/[id]/SelectionDock.tsx`, `app/(authenticated)/media/[id]/media.module.css`: compound/mobile/dock integration and removal of duplicate paint/glyphs |
| independent qualifier | disposable checks outside the repo; short `docs/action-menu-button-verification.md`: actual evidence, limits and cleanup |

sequence: reviewed behavior oracles → shared contract → consumers → integrated
qualification/refactor. a reviewer challenges scope and ownership before each
boundary, then its diff and acceptance evidence afterward. reject duplicated
state, lost bindings, cascade dependence and visual drift before proceeding.
coordinate shared-file edits with inspector work on
`codex/inspector-control-20261014`;
neither plan authorizes changing the other's behavior.

hard cutover: migrate all seven overflow renderers together; remove their text
ellipses, duplicate lucide imports, redundant trigger paint and obsolete comments.
delete newly unused declarations only after a caller search. no flags, legacy
overflow variants or compatibility adapters. retain unrelated ellipses and
active semantic controls. update `docs/modules/visual-system.md` with ownership
and `docs/modules/workspace.md` with the resulting header contract; delete the
resolved appearance ticket and its register
entry only after implementation and qualification.

## acceptance and red → green → refactor → delete

use one disposable browser runner against an identified authenticated candidate
of the real app, using normal services and existing content. no mock action
descriptors, auth bypass, fake test route or production hooks. use local owned
content for the one reversible reorder. no backend/worker provisioning beyond
the ordinary app prerequisites in `README.md`.

| case | required observation |
| --- | --- |
| shared row/header | correct glyph, geometry and every paint state; open paint survives pointer exit; no geometry movement; name/state/control relationship intact |
| input and focus | pointer, enter, space and down open once at the first item; up opens at the last; escape returns to ordinary invoking buttons; desktop nexus restores its combobox/virtual actions cell; no accidental row activation or pane drag |
| collection | ordinary click opens; drag/release suppresses the menu; alt-arrow reorder works; restore original order on owned local content |
| nexus and switchboard | hint, selected row, registered shortcut ref and desktop tab exclusion survive; correct compound/48px targets; opening still holds the correct mobile surface |
| reader and disabled | dock overflow opens successfully in chromium; record the known firefox dismissal and require no worsening there; native/aria-disabled states stay inert and suppress hover; release held requests unchanged |
| preservation | same menu labels/order/options for the same resource state; one existing nonmutating command completes normally; account, zoom and relationship controls keep their icons, styling and behavior |
| visual/accessibility | designer approves populated rows, header, badge and hint in all three rooms; 320px layout, 200% zoom, coarse pointer, reduced motion and forced colors fit; focused-open and disabled+expanded+focused rings stay visible |

1. capture baseline commit plus relevant dirty diff and running build identity.
   write/review assertions first, outside the checkout. run red before coding:
   absent shared svg/resting border/open feedback are valid target failures.
   setup, authentication or locator failures are blockers, never red evidence.
2. implement by the boundaries above. run the unchanged assertions green;
   independently review visual crops and a populated pane. screenshots alone
   do not prove keyboard behavior, focus or accessible names.
3. refactor away duplicate paths; rerun affected cases and `./scripts/test`.
   qualify the actual integrated candidate, including concurrent shared-file
   edits. do not substitute a stale deployed build for the candidate.
4. retain a brief sanitized receipt: candidate identity, browser versions,
   red/green results, selected before/after images, observed limits and cleanup.
   delete only task-owned test code, temporary dependencies/profiles and fixture
   data after final green. retain no test dependency, script target or seam.
   external cleanup does not require repeating the static gate; stop unless
   a new change or concrete failure requires further verification.

run the main pass in firefox; repeat default/header keyboard, custom-ref and
coarse-target checks in chromium. check physical touch if an existing device is
available; otherwise state the emulation/device limit. exercise transient disabled
state naturally or by briefly holding a real snapshot response at the browser
boundary, never by fabricating a response. inspect rendered contrast and focus;
check oracle visually only where an overflow consumer is actually mounted under
that scope, otherwise inspect its tokens. do not label this a complete
accessibility audit.

the user's explicit disposable-test request is a task-local exception to
[testing standards](local-rules/testing-standards.md). `./scripts/test` and ci
remain unchanged as the repository's sole permanent gate. no tests or app code
are written during this specification step.

## accepted tradeoffs

- resting frames add visual weight to dense lists; preserve the approved faint
  border and evaluate it on a populated pane.
- larger touch minima spend space. nexus retains a wider compound shape to
  preserve its useful shortcut and existing interaction.
- one small presentation primitive adds a file boundary while eliminating seven
  inconsistent render paths; semantic controls retain their separate styling.
- unchanged menus retain the separately tracked defects above. temporary tests
  provide cutover evidence but their deletion forfeits automated regression
  coverage; retain this contract and the observed receipt.
