# inactive imports can activate itself during workspace entry

problem: a visible inactive `/imports` pane selects its initial view by writing
the url; that write also makes it the active pane.

evidence: `ImportsPaneBody.tsx:65-68` calls `setState` when `view` is absent;
`lib/panes/usePaneUrlState.ts:38` uses router replace, and
`lib/workspace/store.tsx:459` defaults navigation to `activate: true`.
live on `a08d0245e`: restore visible notes + imports with notes active, then
open `/notes?nexus=1&intent=Root`; imports becomes active while nexus is open.
using `/imports?view=NeedsAttention` keeps notes active.

impact: restoring a background imports pane can change the current navigation
origin. shifted activation follows the actual active origin correctly.

fix: distinguish initial view normalization from user navigation; write this
initial view without activation. review other automatic url normalization callers.

resolved when restoring the bare imports pane records its chosen view while
preserving the active pane, focus and foreground generation.
