# three player surfaces each carry two presentations of one action set

status: open (decision needed) · origin: 2026-09-17 slop sweep (claude session)
· area: player surfaces · oi-147

each surface keeps a viewport boolean, a resize listener or ResizeObserver to
maintain it, and then the same controls expressed twice — once inline, once as
an `ActionMenu` descriptor:

- `MobileNowPlaying.tsx:96` (`window.innerHeight < 680`) selects between the
  `secondaryOptions` menu (102-148, 249-264) and the `styles.secondaryActions`
  row (266-321), which repeats contents, recording actions, open preview/source,
  review captures and open lectern as plain buttons;
- `MobileMiniPlayer.tsx:83` (`window.innerWidth <= 360`) selects between a
  `Player.Capture` menu entry (90-106) and an inline `<PlayerCaptureButton>`
  (217-219);
- `DesktopListeningShelf.tsx:155` (`clientWidth < 1088`) selects between menu
  entries (66-108) and inline capture and volume controls (152-160, 185-196).

deleting one arm per surface removes about 100 lines. no doc names the
breakpoints (nothing in `docs/modules/player.md`). this is a responsive
presentation, not dead code: always choosing the menu buries volume and capture
behind an overflow on a 1400px shelf and contents behind one on a tall phone.

decision: per surface, menu or inline row? "whichever is fewer lines" means the
menu arm wins on all three.

prerequisite: the owner's answer per surface.

fix: delete the losing arm together with its boolean and its resize /
ResizeObserver listener on each surface.

acceptance: each player surface expresses its action set once, and no surface
measures its own viewport to choose between two renderings of the same actions.
