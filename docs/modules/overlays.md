# overlays

## scope

the overlay kernel lets any surface float over the workspace without anyone
losing their place. owners, under `apps/web/src/`:

- `lib/ui/overlay.ts`: the overlay stack. who owns Escape, Back and global
  commands, light dismiss, the scrim rule, the Tab trap, return focus, the
  synthetic history entry.
- `lib/ui/useAnchoredPosition.ts`: where a floating box goes (an element, a
  rect, synchronous source-owned measurement or text-selection lines; element
  placement above/below/right, cross-axis alignment, flip, clamp and re-measure
  on scroll, resize, visual viewport and source layout notifications). hosted
  reader composers use live source geometry; chat-answer selection rectangles
  remain a [separate issue](../issues/selection-dock-does-not-follow-scroll.md).
- `lib/ui/useKeyboardInset.ts`: the ios keyboard geometry and its report to the
  mobile viewport (`lib/mobileShell/viewport.tsx` keeps the report stack).
- `components/ui/ModalFrame.tsx`: the scrim + `role="dialog"` panel every modal
  renders through, with initial focus, the dismissal guard, depth z-index and
  suspension. its skins: `Dialog` (centred, titled), `MobileSheet` (bottom
  sheet, drag to dismiss), `MobileFullScreenTask` (opaque task on the visual
  viewport).
- `components/ui/ActionMenu.tsx` (menu semantics),
  `components/ui/PickerSurface.tsx` (responsive picker placement and focus),
  `components/ui/FloatingActionSurface.tsx` (the non-modal action surface),
  `components/ui/HoverPreview.tsx` (`useHoverPreview`: hover intent and the
  preview card or sheet), `components/ui/Tooltip.tsx` (passive control help).

## the stack

every open dialog, sheet, task, menu, chooser, floating surface and preview is a
layer pushed by `useOverlay(open, options)`, in activation order. tooltips also
register during their opening delay. a layer is a **modal** (an exclusive task,
always a `ModalFrame`), a **transient** (a brief choice), or a **tooltip** (passive
help). transients and tooltips belong to the modal they render inside (react
context from the frame) or to the page.

the **owner** answers Escape, Back and global commands: the newest eligible
transient of the newest modal, else that modal; with no modal, the newest
eligible page transient. a transient of a covered modal never outranks a newer
modal, and a page transient never outranks a modal. `eligible()` is read at
dispatch (the author search owns keys only while focus is inside it).
`hasActiveInteractionOwner()` and `isTopmostInteractionOwner(scope)` read the
same rule; a sheet's scope is its `panelId`. tooltips never become this owner.
`useOverlay` subscribes to its layer's registration, coverage and depth. for a
tooltip, `topmost` additionally requires a live trigger inside the current
owner's boxes or modal panel, or on the page when no owner is open. hidden,
inert and detached triggers are ineligible. this permits help within an active
composer or chooser while suppressing help behind another surface.

delayed navigation captures the current owner and, for a transient, the exact
owner exposed by its normal close. a dismissed modal is not continuing ownership.
the interaction generation advances on interactive admission and real browser
traversal, including back within a retained modal; a frame's own closing
traversal is excluded.
citation previews close with pane deactivation or a new destination/entry.

a tooltip requires `trigger()`, `inside()` and `eligible()`: false means pending,
true means visible. its options forbid command scope and return focus. it never
captures an opener, moves focus or owns Back/history. fresh engagement arms help
without consulting stale closed-state exposure; its render checks the current
stack. coverage cancels it; uncovering alone does not rearm it.

`useInteractionBlocked(scope)` subscribes to that same ownership rule: another
scope, including an unscoped menu, blocks; no owner or one's own scope does not.
focus-driven eligibility changes notify subscribers without altering history.
a closed layer binds its current context parent before its next admission.

every dismissal is `onDismiss(reason)` with reason `escape`, `back`, `outside`,
`tab` or `navigation`; the feature closes by changing its state. a modal asks its
`onDismissRequest()` first: `"blocked"` keeps it open (the feature shows its
confirmation) and Back re-arms. Escape, Back, the scrim, the frame's close
button and the sheet's drag all take that path.

## presses

**light dismiss.** a pointerdown (capture phase) closes, newest first, every
transient of the top modal (or of the page) until one whose `inside()` boxes
contain the press. a transient's anchor element is inside it, so pressing a
trigger never closes and reopens its own surface. a transient without `inside`
is never closed by a press.

the same traversal dismisses pending or visible tooltips outside their
`inside()` boxes. a tooltip neither stops the traversal at an inside box nor
counts as closing a transient, so help never consumes a control or scrim press.
a press on exposed help counts as a press on its trigger when checking older
surfaces, keeping the containing composer or chooser open. the tooltip's
trigger handles its own pointerdown; help preserves native text selection.

**the scrim.** a modal closes from its scrim only on a click that starts and
ends on the scrim and closed no transient on the way: a scrim press with a menu
open closes only the menu, and selecting text in a dialog and releasing over the
scrim keeps the dialog. the frame stops a click from reaching its owner through
the react tree.

## focus

only the topmost frame is `aria-modal` and interactive; a covered frame's panel
is `inert` and its scrim `data-suspended="true"` (clear, no pointer events). Tab
wraps inside the top modal's panel (a handler that prevented Tab keeps it;
`contenteditable` counts as focusable). a frame focuses `initialFocus(panel)`,
else its first focusable, else the panel, one frame after it becomes topmost,
once per open and `focusKey`.

chooser transients opt into `tabContinuation` through the existing key dispatcher:
tab past their last control closes and continues after the opener; shift-tab from
the first closes to the opener. that close does not run normal return-focus again.
mobile chooser sheets retain the modal tab cycle. searchable library choosers
default to search for keyboard invocation and the sheet for touch. a picker's
`initialFocus(panel)` overrides that policy without adding another focus owner.

desktop action menus own their Tab exit: every Tab closes and continues natively from
the live invocation context, in the requested direction. they do not opt into
chooser `tabContinuation`. mobile action menus retain the modal tab cycle.
dialog close targets are 44px on any coarse pointer.

`handleModalTab` owns the boundary, including a programmatic `tabindex=-1`
invoker: native tab continues from its document position when a tabbable remains
in that direction, otherwise it wraps. menus call the same helper because their
isolated key events do not reach the document listener.

**return focus.** at open an interactive layer records its trigger:
`returnFocusTo()`, else the focused element, else (safari never focuses a clicked
button) the focusable element the last press landed on. at close, focus goes to the live
`returnFocusTo()`, else the trigger, else `returnFocusFallback()`, only for the
layer being exposed: a modal that was topmost, or a transient that opted in
(`returnFocus`) whose modal is topmost and that no outside press closed.
`skipReturnFocus()` vetoes (a navigating close already put focus at the
destination). the last modal's restore runs again after its history traversal
if focus fell to the body. an inert-uncover retry retires when another control
claims focus, even if that control later detaches. a menu returns focus before its chosen command runs,
so whatever the command opens names the trigger, not the vanishing item, as its
opener. nexus supplies its search input as invocation context. escape returns
there without scrolling; outside dismissal does not restore. reader selection
and clicked-highlight composition belong to `FloatingActionSurface`.

## history

while any modal is open exactly one synthetic entry exists
(`history.state.__nexusOverlay`), so Back means "dismiss" on every engine and
in the android app, whose Back is `webView.goBack()`. a Back press dispatches
`back` to the owner; if a modal remains (a blocked guard, a closed menu inside
a sheet), a fresh entry is pushed. when the last modal closes by ui the entry is
traversed off; if the address moved meanwhile (the workspace replaces it after a
navigating close), the landed entry keeps the destination's address, so no dead
entry is left behind. a modal opening during that traversal gets a fresh entry,
and a modal closing as another opens in the same commit keeps the entry (one
sync per commit). with no modal open there is no entry: page menus, floating
surfaces and previews never own Back.

menu preparation and desktop menus opt into retirement on real browser
navigation. the kernel classifies that traversal and closes them without
returning focus. its own traversal after the last modal closes is cleanup,
not navigation, and cannot retire a newly admitted menu.

the costs of one entry per modal, desktop included: opening a modal discards
the browser's forward history; a ui close leaves the traversed-off entry ahead
as a forward entry, so Forward lands on a no-op entry and the next Back is dead;
reloading with a modal open leaves its entry behind as one dead Back press (no
modal reopens on load). giving them up means giving up Back on desktop.

## rendering

frames render in `document.body` and stack at `calc(var(--z-modal) + depth)`,
depth being the frame's index among open modals: activation order alone decides
which is on top. transients and tooltips render in their containing modal's panel
(`useOverlayContainer()`), else in the body at `--z-popover` (900): above mobile
chrome (`--z-overlay`), below every modal. workspace feedback stays in flow
and is suppressed while a modal owns interaction. the quick-note handoff input
(`--z-nexus`) stays above every frame. a page's own fixed shell (the `/share` card) takes no z-index, or it
buries them. the app's body never scrolls (panes do); where a bundle lets it
scroll (the android shelf), css locks it while any frame is open
(`body:has([data-modal-backdrop="true"]:not([hidden]))`).

frames may be mount-gated or driven by `open`; either way a close pops the
layer and syncs history. `MobileFullScreenTask` keeps its content mounted after
the first open (`keepMounted`), so task state survives close, reopen and
rotation. sheet and dialog content unmount when closed.

retained content supplies its destination's actual `OverlayContext` when moved
between containers. `useOverlay` binds the current parent before admission;
cleanup uses the preceding admission's parent. companion retention and its
transition deferral belong to [workspace](workspace.md#companion).

## listener order

the kernel's document listeners are installed with the first layer. the
tooltip-only capture listener ignores prevented/composing Escape and cancels
every pending hint across scopes without taking the key. it dismisses only the
newest visible exposed hint in the current modal scope, preventing default and
stopping propagation. that Escape leaves the containing task and its focus
alone; a subsequent Escape follows the task's existing dismissal path.

modal/transient Escape and Tab remain in the bubble listener, after react's
root listeners: a component's own key handler runs first and keeps a key by
preventing its default (the Nexus inputs own Escape this way). a
feature's own global Escape command must yield while
`hasActiveInteractionOwner()`; the reader (`media/[id]/chrome.tsx`) does, so
Escape with its inspector sheet on top closes only the sheet. react listens on
every portal container too: a portaled component that stops a key's
propagation hides it from the document. `ActionMenu` stops every key, since
react bubbles a portaled menu's keys through its owners (the linked-notes
editor's block keys would take Escape and Delete), and so answers Escape itself
(focus in the menu makes it the owner).

## passive navigation help

the collapsed rail's labels and its Search help are the shared **Tooltip**
(below) with `placement: "right"`, `openDelayMs: 0` and `disabled` while the rail
is expanded: one `tooltip` layer, so escape, outside press and modal coverage
are the kernel's, and the caption never becomes the interaction owner or
suppresses command/control+k. its corridor is the 8px inline-start padding.

## surfaces

**PickerSurface**: a desktop transient anchored above or below its trigger,
with flip/clamp, or the existing mobile sheet. the default desktop shell is a
named dialog; a listbox consumer supplies its own named root and sets
`desktopRole={null}`. `initialFocus(panel)` chooses the focus target after
placement. the caller owns choice semantics and content; the surface owns
dismissal, tab continuation and return focus through the existing kernel.
`--picker-surface-width` sets desktop width (380px by default); mobile geometry
belongs to `MobileSheet`. inline presentation is a named region with an explicit
close action and no outside-press dismissal.

**MobileSheet**: fixed visible title and close x above an independently scrolling
body; the full title names the dialog and close control. `renderHeader` replaces
the standard header and receives the frame's guarded `requestDismiss`; specialized
headers must retain a visible exit. noninteractive header space is a drag target
at least 44px high, with a 36×4px grabber. a drag of 96px asks the same guard as
x, scrim, escape and back; cancellation restores position. reduced motion removes
animated travel while retaining dismissal. scrim is `"default"`, or `"soft"` for
in-context companion sheets. keyboard lift uses `--keyboard-inset` and safe-area
padding. geometry lives only in `MobileSheet.module.css`.

**MobileFullScreenTask**: one opaque frame fixed to the visual viewport (top
follows the ios viewport pan, bottom clears the keyboard); no scrim, grabber or
drag. Back and Escape go through the feature's guard. mobile Nexus is its one
user: nonblank Root clears its query first, a nested page returns to Root, dirty
work keeps its confirmation, blank Root closes.

**ActionMenu**: a "…" or custom trigger. `MenuSource` supplies a known subject key
and title plus immediate complete content or preparation keyed by the exact abort
signal. initial preparation retains trigger focus, marks it busy and owns only a
hidden transient. its five-second budget starts at activation and is checked again
after measurement; no local subset appears while waiting. cancellation aborts and
forgets. publication owns one desktop transient or mobile modal, never both.

desktop complete choices use menu semantics; failure and successful-empty use a
named transient dialog. retry retains the failure surface, owner, focus and history
while taking a fresh signal and budget. mobile uses a titled `MobileSheet` with
ordinary buttons/links and modal tab order. touch focuses the panel, keyboard the
requested command edge. `aria-haspopup` matches the displayed role.

Enter, Space and ArrowDown open on the first item, ArrowUp on the last; arrows
wrap, Home/End and typeahead navigate items. every item has `tabIndex=-1`;
disabled items remain arrow-focusable and display a wrapping reason. Tab and
Shift+Tab make the departing menu inert, focus its live invocation context,
close without deferred return-focus, then let native focus continue. only an
enclosing modal boundary wraps. this also applies while failed, empty or
disabled-only on desktop. custom editable controls retain their editing keys.
focus moves to the first (or last) item once, after the first
placement, so a moving anchor never resets the keyboard position. choosing a
command returns focus before it runs unless it opts out. a handled workspace
link transfers focus ownership to navigation; closing must not reactivate its
source pane. an unhandled native mouse link retains normal menu restoration.
an outside press closes without moving focus.
published command meaning and target geometry remain stable. changed title,
sections, labels, targets, reasons, controls or unsolicited layout close with one
announcement; a fresh activation is required. same-geometry availability and
handlers remain live. capture checks precede custom/native activation, including
shifted and auxiliary links. list scrolling and header drag are deliberate movement.
compensated target geometry is compared at 1/64 css px precision so compositor
rounding during sheet entry/drag does not count as layout change. viewport facts
remain exact and are checked at publication and activation, before deferred resize
delivery can permit a stale press. viewport changes retire pending or published
invocations. `onOpenChange` reports
actual visibility only; preparation never starts there. `ActionMenu` owns mobile
chrome hold. `returnFocusTo` can name the invocation context independently of the trigger;
absent it, the trigger owns return. canonical main's passage-composer reader
cutover retires the old directly anchored mode before its shared-menu removal.

**FloatingActionSurface**: the text-selection toolbar (above the first visible
line, below the last on phones, beside the selection, else pinned to the
nearest edge, with a caret at the selection), clicked-highlight choosers,
composers and action-bar popovers. Escape, an outside press and, inside a
modal, Back dismiss it; `preservePointerSelection` keeps a live selection when
pressed.

**useHoverPreview**: mouse or pen hover, or keyboard focus while focus is
visible, opens a card above the citation after 150 ms; leaving the citation
closes it 150 ms later unless the pointer reaches the card; a press on the
citation, Escape, an outside press and focus moving away close it. touch never
hover-opens; `show()` opens at once, and on a touch screen the preview is a
modal sheet that Back closes.

**Tooltip**: plain-text help for native buttons and links. callers spread its
callback ref, handlers and description onto the actual control (the inner anchor
for `Button asChild`), preserving the control's name and activation semantics.
it sits below the trigger, aligned to its end and flipped when it must, or to
its right, centred (`placement`). mouse/pen hover opens after `openDelayMs`
(500ms by default); leaving during that delay cancels it. `disabled` never
opens and closes a visible caption. focus-visible opens at once,
including in the mobile layout; touch never opens help. while visible, pointer
engagement with the trigger or help, or keyboard focus on the trigger, retains
it. departure has 150ms grace and the surface includes an 8px transparent
corridor on the trigger's side to support slow pointer travel. trigger activation, outside press,
Escape, window blur, unmount or coverage closes and cancels it, and a caption
that shows closes any other still visible (one at a time); only fresh
pointer/focus entry rearms it. the trigger keeps its accessible name
and references the rendered `role="tooltip"` with `aria-describedby`. no native
title, automatic expiry, focusable contents or touch sheet. the portal stops
mousedown/click bubbling into the pane chrome without preventing selection.
its outer surface, including the hover corridor, carries `data-passive-tooltip`.
features may ignore pointerdown there when tracking destination ownership;
focusin, blur and outside presses retain their own meaning. the marker denotes
passive help, not an interactive preview card.

## why no native dialog

the platform floor would allow `<dialog>.showModal()` and the `popover`
attribute, and the kernel uses neither. a blocking modal dialog makes everything
outside it inert and paints it below. the quick-note handoff, which focuses a textarea outside the
open mobile Nexus task as the first effect of a gesture, could not focus it; and
chromium's close watcher would let a second Back force-close a guarded sheet.
workspace feedback no longer depends on painting above modals. the remaining
cost is a javascript Tab trap, the `inert`/`aria-modal` projection and depth
z-indices.

## browser floor

chromium 110+, firefox 121+ (esr 128), safari 16+ and the android system
webview (it tracks chrome), for `inert`, `:has()`, `findLast`/`toReversed`,
`:focus-visible` and `visualViewport`.

## verification

verification follows the [repository contract](../local-rules/testing-standards.md).
real browser probes drive back as history traversal; device and spoken
assistive-technology claims require their actual platform. the soft keyboard, ime
composition and touch preview of a real available source require device checks.

## rejected hacks

`--vh`-style `innerHeight` polyfills, `setTimeout`-after-focus
`scrollIntoView`, `maximum-scale=1`, global `touchmove` `preventDefault`,
user-agent sniffing, the VirtualKeyboard API.

## feedback disclosure

`FloatingActionSurface` supports non-modal disclosure using the same overlay
stack and positioning owner. the compact summary is its geometry anchor and the
actual disclosure button its focus trigger. escape restores the trigger; the
kernel's `tabContinuation` continues into/out of the disclosed actions without
a modal trap. positioning keeps the surface beside the full summary, including
wrapped controls. the shared
positioning hook reads the browser viewport directly; standalone public and
shelf readers mount only the existing mobile geometry provider.

## reader action placement

`FloatingActionSurface` accepts a measured anchor callback plus an optional
source subscription. measurements include the reader bounds and selected line
boxes; null geometry with live bounds pins an unavailable draft without a
caret. placement intersects those bounds with the usable visual viewport.
`data-anchor-state` distinguishes visible, offscreen and unavailable. children
may render from `(placed, anchorState)` so editor focus waits for actual visible
placement, with no timer or duplicate host state. ordinary element/rect anchors
remain for their existing consumers.

the hosted composer is a nonmodal group with normal tab order. its rich editor
consumes escape only for its own nested controls; otherwise the overlay kernel
receives it. navigation deactivates the source overlay before the destination
can own escape/focus.

destination presenters close without return focus after handled new-pane
navigation. `FloatingActionSurface.skipReturnFocus` carries that decision through
anchored previews; consumed repeated enter leaves the surface open.
`ModalFrame.interactionLayer` publishes its existing layer identity to a create
owner, including a closed launcher that opens that layer during dispatch. delayed
landing may retain its own layer; competing layer admission revokes authority.
