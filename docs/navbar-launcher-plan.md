# navbar launcher specification and implementation plan

status: implemented and qualified; disposable tests deleted · decisions: 2026-10-14 · baseline: `367da80e0c1beb1c426f6d2d72201b0733809b50`
review: independent content/design, architecture, and accessibility/verification passes.
results: [live/static verification](navbar-launcher-verification.md).

make the control predict its action: a navbar button opens nexus; only the
query inside nexus looks editable. scope is the desktop launcher and its
collapsed tooltip, including repair of the existing destination-tooltip owner.
the owner explicitly excluded [query-arrow editing](tickets/nexus-query-arrows-intercept-text-editing.md).

## target and content contract

| surface | exact content / behavior |
|---|---|
| expanded launcher | magnifier, `Search`, existing platform shortcut |
| accessible name | `Search`; retain native button, `type="button"`, `aria-haspopup="dialog"`, `aria-keyshortcuts` |
| shortcut | derive from `SHORTCUTS["Nexus.Open"]` and `formatShortcut`: `⌘K` or `Ctrl+K` |
| collapsed tooltip | `Search (${hint})`; destination tooltips retain their existing labels |
| opened query | existing `Find anything…`; actual editable combobox receives focus |

the content designer owns those strings and visual review. good content names
the dominant task, matches adjacent labels, and exposes the accelerator without
suggesting editable navbar text. the launcher label has no ellipsis, “ask
anything”, extra explanation or invented command name; casing follows peers.

keep the launcher below the brand and above destinations. share their row
geometry, icon column, baseline, typography, weight, radius, hover and focus
treatment; use a 20px magnifier. rest is transparent with muted ink, no outer
border or input surface. keep the subordinate keycap. no destination-selection
marker, new accent, animation or separator. collapsed mode centers the icon in
the full peer-sized target. expanded mode has no tooltip.

native click/enter/space still calls `requestNexusOpen({ kind: "Root" })` once.
opening preserves the current workspace destination; dismissing an empty
dialog returns focus through the existing modal owner. command/control+k
retains its existing controller and behavior.

## composition, local api and state

`AppNav` owns presentation and activation → existing nexus ingress/controller
owns the command center → existing modal owns query focus and return focus.
the rail-local tooltip owns supplemental help only. no backend api, persistent
schema, transport, new runtime dependency or second search path is needed.

add `useRailTooltip(enabled)` in `components/appnav/useRailTooltip.tsx`:

| member | contract |
|---|---|
| `trigger(controlId, text)` | returns pointer-enter/leave, focus/blur handlers and `aria-describedby`; no ref, activation or keyboard ownership |
| `dismiss()` | clears the active caption; idempotent; never moves focus |
| `tooltip` | one rendered portal, or null; text-only, nonfocusable `role="tooltip"` |

use existing destination ids and `"Nexus.Open"` as identities. state is one
`{ controlId, anchor: HTMLElement, text } | null`, plus a stable tooltip id/ref.
only the active trigger describes the visible caption. opening is event-driven;
persistent hover/focus cannot reopen cleared state. no registry, provider,
per-control state, timeout or restore stack.

freeze two css hooks: outer `tooltipHost` owns positioning ref/style, measured
trigger min-height, hover corridor and pointer handlers; inner `tooltip` owns
the stable id, role and text. css owns gap/padding and bubble appearance.
mount the host for measurement when enabled, active, topmost and its portal
container exists. expose `aria-describedby` and escape capture only once
positioned and visible; remove both immediately when hidden. never gate the
measurement mount on `position.placed`. no `title`, tab stop or interactive child.

wire the launcher and existing `NAV_RAIL` consumers only. their existing click
handlers call `dismiss()` before opening/navigating; preserve native and modified
link activation. footer, account and mobile controls are outside this rollout.

reuse `useAnchoredPosition`; extend `AnchorOptions.placement` only with
`"right"`. alignment remains cross-axis: vertical for right, horizontal for
above/below. preserve defaults, selection placement, viewport clamping,
scroll/resize tracking and cleanup. preserve `flip` semantics, allowing right
to flip left internally; expose no new left-placement option. the rail uses
right/center, zero geometry gap and no flip. its transparent connecting region
supplies the visual gap and spans the full measured trigger edge.
implementation review refinement: the existing resize observer also watches
the live element anchor, so rail-width animation cannot detach the caption.

reuse `useOverlay(open, { kind: "transient", eligible: () => false, ... })` and
`useOverlayContainer()`. inside boxes include trigger and caption/corridor; outside
press dismisses. omit return-focus behavior. ordinary transient ownership
would block command/control+k in `useNexusController`; do not use it or
`useHoverPreview`, whose interaction ownership and touch sheet are unsuitable.

## tooltip behavior

- collapsed mouse/pen entry or keyboard-visible focus (`:focus-visible`) opens
  help, unless another interaction owner is active. a new trigger replaces it.
- retain while the active trigger has keyboard focus OR the pointer occupies trigger,
  continuous corridor or caption. leaving one source cannot defeat the other.
  no touch-hover emulation; tapping still activates the button.
- plain, unhandled, non-composing escape dismisses without moving focus. a
  capture listener exists only while visible; it yields to
  `hasActiveInteractionOwner()`, otherwise prevents default and propagation.
  no unrelated escape action may run. reopen only on a fresh entry/focus event.
- activation, expansion, desktop unmount and modal coverage clear state.
  hide immediately when overlay `topmost` becomes false and clear in a layout
  effect; closing the modal cannot revive stale state. normal focus restoration
  is a fresh focus event and may show help again.
- follow a visible anchor through scroll/resize; dismiss when wholly clipped
  out of view. observe only the active anchor; clean up on replacement/close.
  do not dismiss every scroll: focusing a row can scroll it into view.
- portal outside rail clipping, below modal surfaces using `--z-popover`.
  keep the caption inside the viewport and every trigger-to-caption path
  traversable. retain a visible focus indicator and a valid description id.

these implement the dismissible, hoverable and persistent requirements of
[wcag 1.4.13](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html).

## bounded work and file ownership

source paths are relative to `apps/web/src/`; docs paths are repository-relative.
each row has one implementer; reviewers do not edit another owner's files.

| workstream | files / responsibility |
|---|---|
| presentation + content | `components/appnav/AppNav.tsx`, `components/appnav/AppNav.module.css`: approved copy, shared row declarations, wiring, bubble/corridor styles |
| tooltip mechanics | new `components/appnav/useRailTooltip.tsx`, `lib/ui/useAnchoredPosition.ts`: local interaction contract and bounded positioning extension |
| live verification | disposable driver outside the repo; later `docs/navbar-launcher-verification.md` records observed results and capture locations |
| integration | this plan; later `docs/modules/app-navigation.md`, `docs/modules/overlays.md`, scoped tickets/register: final contracts, evidence and closure |

verify the baseline first; presentation and mechanics then use the frozen
contract above independently. the integrator owns joined behavior. the designer
reviews launcher copy/geometry and tooltip copy/legibility; architecture and
accessibility reviewers challenge each stage against the contracts.

hard cutover: remove `tip`, `showTip`, old destination-specific tooltip handlers,
fixed tooltip markup/coordinates and `pointer-events: none`. replace faux-field
styles, not override them. share row declarations without combining item
`width: 100%` with launcher outer margins, which would overflow. leave one
owner for width/insets. no compatibility branches, aliases or feature flag.

## qualification: red → green → refactor → delete

the owner's explicit temporary-live-test request is a task-specific exception
to the [static-only convention](local-rules/testing-standards.md). it does not
create a permanent suite or change `./scripts/test`.

1. write a disposable end-to-end browser driver against the real authenticated
   app. use isolated contexts, real services and a disposable account; no mocked
   ingress/results or test-only production seams. execute no content/result/
   workspace actions; ordinary bootstrap/session writes stay in that account.
   independently capture launcher and existing-destination reds, plus existing behavior's
   baseline greens; one failure cannot mask another. setup/auth failure is
   blocked, never a valid red.
2. implement; make all cases green. inspect actual screenshots against the
   content/design contract; css-class assertions do not prove the affordance.
3. adversarially review ownership, event order, focus, cleanup and dead paths.
   refactor; rerun the small acceptance set and `./scripts/test` on the final code.
4. record source sha/dirty state, time, url, browser/platform/viewport, actual
   red/green results, visual verdict, captures and static result. delete the
   driver, fixtures, temporary dependencies/auth and any test-only material.
   stop only services created for this work; retain the concise receipt.

| acceptance case | evidence required |
|---|---|
| baseline green | click/enter/space open the existing root once; real query focused; empty escape closes and returns focus; destination unchanged |
| required red → green | approved `Search` copy and row appearance; collapsed launcher hover/focus caption and mounted description relationship |
| required red → green | launcher AND one existing destination: cross full trigger edge into caption; hover/focus independently retain; departure closes; escape stays closed until fresh entry; no focus transfer or underlying escape action |
| integration | command/control+k works with help visible; modified/composing escape stays untouched and an active overlay retains escape; no caption above dialog; activation/expansion/unmount clear state; scroll follows visible anchor and clears hidden anchor |
| visual/platform | light/dark/elvish; expanded 240px/collapsed 48px; both platform hints fit; no overlapping targets, clipping or horizontal overflow; 20px icon never shrinks; keyboard focus visible |
| viewport/input | 769→768→769px preserves collapse choice and mobile entrance; a desktop-width touch tap (>900px) opens nexus without tooltip flash or stale caption |
| shared primitive | one existing above and below popover still positions/opens/dismisses correctly; selection-placement path remains unchanged |

use the existing server-derived platform in a windows-user-agent context to
verify control+k; do not add a platform override. these are read-only journeys:
opening/dismissing proves integration without executing search results/actions.
record unexercised assistive-technology coverage explicitly; semantic inspection
alone is not a screen-reader pass. static checks alone are not a live pass.

## scope limits and accepted costs

- `Search` under-advertises ask/create actions; the opened surface exposes them.
  a quieter row trades prominence for a truthful navbar affordance.
- immediate help avoids timers but makes pointer exploration more visually
  active. a local hook absorbs real interaction complexity; no global tooltip
  framework or overlay-kernel rewrite. passive help requires a local escape
  listener because ordinary ownership also suppresses global shortcuts.
- extending shared placement avoids duplicate geometry but requires the bounded
  above/below regression check. observing a live anchor adds one observation to
  the existing positioning observer. deleting live tests relinquishes automatic
  regression protection; this specification and observed receipt remain.
- no query editing, ranking, mobile redesign, navigation reorder, new command,
  footer-tooltip rollout, telemetry, backend or unrelated cleanup.

the affordance, collapsed-launcher help and shared-hoverability tickets are
resolved and deleted after acceptance. query editing remains separately open.
temporary tests and credentials are deleted; task containers are stopped.
the owner's recovery handoff requires retaining every task volume, including
the two bind-mounted auth templates; no volumes were removed.
