# resource action completion uses the then-active pane

status: open
origin: 2026-10-16 principal-action architecture review
area: web / resource actions / workspace navigation

evidence: `apps/web/src/lib/actions/project.tsx:114-121` reads the active pane
each time navigation runs. `:276-280` and `:306-310` await chat creation or
learning before invoking that navigation. `lib/workspace/targetActivation.ts:127-130`
then follows in that origin or creates after it. these paths retain the correct
resource but lose the initiating pane. source-confirmed; no browser reproduction.

impact: switching panes during a slow "learn from this" can replace the newly
active, unrelated pane; "chat about this" opens beside the wrong origin and
reactivates the workspace after the user moved on.

prerequisites: two visible panes and a delayed create/learn response. start the
action in one, activate the other before completion, then release the response.

proposed fix: capture the owning pane and visit when the command is selected.
after the await, respect whether that visit still owns navigation; if it does
not, expose the created result without repurposing another pane. use the
existing workspace activation owner and feedback controls.

acceptance: delayed completion keeps its resource and origin; changing or
closing that origin never navigates an unrelated pane or throws for a missing
origin; the created result remains reachable.
