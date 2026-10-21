# new-page publication replaces the active editor

problem: first-content autosave replaces the new-page route with the saved-page
route as soon as the server acknowledges it. those routes mount different bodies;
the handoff transfers text but no caret, editor history or current focus ownership.

impact: the first acknowledgement can interrupt ongoing writing by replacing its
editor, potentially dismissing a mobile keyboard or losing local undo continuity.
the remount and missing transfer are source-established; visible keyboard/focus
effects require browser verification.

evidence: `apps/web/src/app/(authenticated)/pages/new/NewPagePaneBody.tsx:137-141`
admits first-content save after 1.5 seconds; `:89-122` adopts bodies and calls
`runtime.router.replace`, while its editor at `:151` uses local history.
`apps/web/src/lib/panes/paneRenderRegistry.tsx:33-35` resolves the two routes to
different components. `apps/web/src/lib/panes/paneRuntime.tsx:130-147` performs
navigation without an editor selection/history handoff. the saved page focuses
notes only for an explicit `FocusNote` entry (`PagePaneBody.tsx:68-78`).

resolution: keep the same editor/session through draft-to-acknowledged publication,
updating resource identity/status without replacing the active editing surface.
if a route handoff remains necessary, preserve caret/history and require current
interaction ownership before restoring focus.

resolved when first-save acknowledgement during desktop typing or mobile
composition preserves the editor, caret, undo sequence and keyboard, while an
acknowledgement after deliberate focus movement does not reclaim focus.

current implementation evidence: `3942b8fd2`, private run
`20261021-124029-3695898bc692`, publication case: the original editor's
`isConnected` is false after route adoption. a shared component alone did not
preserve it through the pending/canonical loading transition. source repair and
repeat qualification are required.
