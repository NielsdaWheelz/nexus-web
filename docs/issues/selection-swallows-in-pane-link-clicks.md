# an unrelated selection may swallow an in-pane link click

source hypothesis at `09c14e68f`; not reproduced.
`suppressSelectionActivation` in `apps/web/src/lib/ui/targetActivation.ts`
suppresses a plain pointer activation whenever the window has a non-collapsed
selection, without checking whether it intersects the target.
`apps/web/src/lib/panes/targetLinkActivation.ts` applies this guard to in-pane
links.

impact: a link outside the selected passage may appear inert. ordinary mouse
down often collapses the selection first, so the usual click can work;
`user-select: none` controls and touch need a real boundary check before the
guard is changed.

resolved when: an unrelated selection does not block intentional link
activation, while selection gestures cannot accidentally open the source.
