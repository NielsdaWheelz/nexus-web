# failed restore can autosave a default over the stored workspace

status: open · origin: 2026-10-02 read-only architecture audit, `a65ed0f014` / #436 · area: workspace bootstrap

this predates #436's save acknowledgment repair. `bootstrap.server.ts:114-128`
returns null on session transport failure under the 500 ms prefetch deadline.
for a deep-link Navigate, :202-228 then creates a default workspace and sets
`persistInitialState=true` because no restored pane exists. the hook initializes
acknowledged state to null (`useWorkspaceSession.ts:21-23`) and autosaves after
one second (:128-134). `workspace_sessions.py:53-67` unconditionally replaces
the stored object for that user/device. merely opening a deep link after a slow
restore can therefore overwrite previously saved panes/history without an edit.

these are exact source-owned transitions, not an observed browser reproduction.
the optional rendering fallback is documented; automatic durable replacement
when the previous state is unknown is a separate destructive consequence.
this is not a new cross-tab ordering or unload guarantee request.

prerequisite: decide whether this replacement is intended product behavior.
if not, bootstrap must distinguish an unavailable restore from confirmed
absence and avoid automatic initial persistence of the fallback. keep genuine
user edits and the current last-write-wins service; no server revision protocol.

acceptance: seed a nontrivial saved workspace, fail/delay only the bootstrap
session read past its deadline, open a deep link and make no edit; the durable
workspace remains unchanged. confirmed absence and successful restore/deep-link
merge retain their current persistence behavior. verify actual browser/BFF/API.
