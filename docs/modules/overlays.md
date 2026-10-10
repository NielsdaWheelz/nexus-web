# overlays

## scope

the overlay kernel lets any surface float over the workspace without anyone
losing their place. owners, under `apps/web/src/`:

- `lib/ui/overlay.ts`: the overlay stack. who owns Escape, Back and global
  commands, light dismiss, the scrim rule, the Tab trap, return focus, the
  synthetic history entry.
- `lib/ui/useAnchoredPosition.ts`: where a floating box goes (an element, a
  rect or a text selection's lines; flip, clamp, re-measure on scroll and
  resize). a captured rect does not move with a scroll, so the selection
  surfaces stay put ([ticket](../tickets/selection-dock-does-not-follow-scroll.md)).
- `lib/ui/useKeyboardInset.ts`: the ios keyboard geometry and its report to the
  mobile viewport (`lib/mobileShell/viewport.tsx` keeps the report stack).
- `components/ui/ModalFrame.tsx`: the scrim + `role="dialog"` panel every modal
  renders through, with initial focus, the dismissal guard, depth z-index and
  suspension. its skins: `Dialog` (centred, titled), `MobileSheet` (bottom
  sheet, drag to dismiss), `MobileFullScreenTask` (opaque task on the visual
  viewport).
- `components/ui/ActionMenu.tsx` (menu semantics),
  `components/ui/FloatingActionSurface.tsx` (the non-modal action surface),
  `components/ui/HoverPreview.tsx` (`useHoverPreview`: hover intent and the
  preview card or sheet).

## the stack

every open dialog, sheet, task, menu, chooser, floating surface and preview is a
layer pushed by `useOverlay(open, options)`, in activation order. a layer is a
**modal** (an exclusive task, always a `ModalFrame`) or a **transient** (a brief
choice). a transient belongs to the modal it renders inside (react context from
the frame) or to the page.

the **owner** answers Escape, Back and global commands: the newest eligible
transient of the newest modal, else that modal; with no modal, the newest
eligible page transient. a transient of a covered modal never outranks a newer
modal, and a page transient never outranks a modal. `eligible()` is read at
dispatch (the author search owns keys only while focus is inside it).
`hasActiveInteractionOwner()` and `isTopmostInteractionOwner(scope)` read the
same rule; a sheet's scope is its `panelId`.

every dismissal is `onDismiss(reason)` with reason `escape`, `back` or
`outside`; the feature closes by changing its state. a modal asks its
`onDismissRequest()` first: `"blocked"` keeps it open (the feature shows its
confirmation) and Back re-arms. Escape, Back, the scrim, the frame's close
button and the sheet's drag all take that path.

## presses

**light dismiss.** a pointerdown (capture phase) closes, newest first, every
transient of the top modal (or of the page) until one whose `inside()` boxes
contain the press. a transient's anchor element is inside it, so pressing a
trigger never closes and reopens its own surface. a transient without `inside`
is never closed by a press.

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

**return focus.** at open a layer records its trigger: `returnFocusTo()`, else
the focused element, else (safari never focuses a clicked button) the focusable
element the last press landed on. at close, focus goes to the live
`returnFocusTo()`, else the trigger, else `returnFocusFallback()`, only for the
layer being exposed: a modal that was topmost, or a transient that opted in
(`returnFocus`) whose modal is topmost and that no outside press closed.
`skipReturnFocus()` vetoes (a navigating close already put focus at the
destination). the last modal's restore runs again after its history traversal
if focus fell to the body. a menu returns focus before its chosen command runs,
so whatever the command opens names the trigger, not the vanishing item, as its
opener; a menu anchored at a clicked highlight returns it to what had focus at
open without scrolling the reader.

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

the costs of one entry per modal, desktop included: opening a modal discards
the browser's forward history; a ui close leaves the traversed-off entry ahead
as a forward entry, so Forward lands on a no-op entry and the next Back is dead;
reloading with a modal open leaves its entry behind as one dead Back press (no
modal reopens on load). giving them up means giving up Back on desktop.

## rendering

frames render in `document.body` and stack at `calc(var(--z-modal) + depth)`,
depth being the frame's index among open modals: activation order alone decides
which is on top. transients render in their containing modal's panel
(`useOverlayContainer()`), else in the body at `--z-popover` (900): above mobile
chrome (`--z-overlay`), below every modal. the feedback HUD (`--z-toast`) stays
above everything and the quick-note handoff input (`--z-nexus`) above every
frame. a page's own fixed shell (the `/share` card) takes no z-index, or it
buries them. the app's body never scrolls (panes do); where a bundle lets it
scroll (the android shelf), css locks it while any frame is open
(`body:has([data-modal-backdrop="true"]:not([hidden]))`).

frames may be mount-gated or driven by `open`; either way a close pops the
layer and syncs history. `MobileFullScreenTask` keeps its content mounted after
the first open (`keepMounted`), so task state survives close, reopen and
rotation. sheet and dialog content unmount when closed.

## listener order

the kernel's document listeners are installed with the first layer, after
react's root listeners: a component's own key handler runs first and keeps a
key by preventing its default (the Nexus inputs own Escape this way). a
feature's own global Escape command must yield while
`hasActiveInteractionOwner()`; the reader (`media/[id]/chrome.tsx`) does, so
Escape with its inspector sheet on top closes only the sheet. react listens on
every portal container too: a portaled component that stops a key's
propagation hides it from the document. `ActionMenu` stops every key, since
react bubbles a portaled menu's keys through its owners (the linked-notes
editor's block keys would take Escape and Delete), and so answers Escape itself
(focus in the menu makes it the owner).

## surfaces

**MobileSheet**: scrim (`"default"`, or `"soft"` for in-context companion sheets),
grabber drag past 96 px asks the guard (not under reduced motion), lift above
the ios keyboard via `--keyboard-inset` and safe-area padding. its geometry
lives only in `MobileSheet.module.css`.

**MobileFullScreenTask**: one opaque frame fixed to the visual viewport (top
follows the ios viewport pan, bottom clears the keyboard); no scrim, grabber or
drag. Back and Escape go through the feature's guard. mobile Nexus is its one
user: nonblank Root clears its query first, a nested page returns to Root, dirty
work keeps its confirmation, blank Root closes.

**ActionMenu**: a "…" or custom trigger, or a menu anchored at a clicked rect.
Enter, Space and ArrowDown open on the first item, ArrowUp on the last; arrows
wrap, Home/End, typeahead, Tab wraps inside; disabled items stay focusable and
say why. focus moves to the first (or last) item once, after the first
placement, so a moving anchor never resets the keyboard position. choosing an
item closes the menu and returns focus unless the item opts out; an outside
press closes without moving focus; scrolling closes an anchored menu.
`onOpenChange` reports each open and each close once (mobile chrome holds on
it).

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

## why no native dialog

the platform floor would allow `<dialog>.showModal()` and the `popover`
attribute, and the kernel uses neither. a blocking modal dialog makes everything
outside it inert and paints it below: the feedback HUD, which toasts while modal
sheets are open, would sink under them, stop taking presses and leave the
accessibility tree; the quick-note handoff, which focuses a textarea outside the
open mobile Nexus task as the first effect of a gesture, could not focus it; and
chromium's close watcher would let a second Back force-close a guarded sheet.
the cost is a javascript Tab trap, the `inert`/`aria-modal` projection and depth
z-indices.

## browser floor

chromium 110+, firefox 121+ (esr 128), safari 16+ and the android system
webview (it tracks chrome), for `inert`, `:has()`, `findLast`/`toReversed`,
`:focus-visible` and `visualViewport`.

## verification

the overlay harness (playwright-managed chromium, firefox and webkit; desktop
and phone viewports) drives Back as a history traversal. unproven there: the
soft keyboard ([ticket](../tickets/mobile-keyboard-inset-has-no-browser-proof.md)),
the real android webview, ime composition, a floating surface inside a modal
([ticket](../tickets/action-bar-popover-has-no-producer.md)) and the touch
preview sheet (no fixture cites an unavailable source). when their behaviour
changes, check those by hand on a handset.

## rejected hacks

`--vh`-style `innerHeight` polyfills, `setTimeout`-after-focus
`scrollIntoView`, `maximum-scale=1`, global `touchmove` `preventDefault`,
user-agent sniffing, the VirtualKeyboard API.
