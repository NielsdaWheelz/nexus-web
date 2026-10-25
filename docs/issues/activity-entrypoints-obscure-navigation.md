# activity entry points obscure navigation

problem: the workspace recovery tray permanently occupies primary chrome even
when empty. it presents secondary account-wide status as a pane-level command.
the owner reports clutter in the desktop rail and every mobile pane header.

evidence: `docs/modules/visual-system.md:100-108` explicitly requires an empty
rail/header slot. `apps/web/src/components/appnav/AppNav.tsx:187` mounts it in
the rail; `apps/web/src/components/workspace/PaneShell.tsx:440` injects it into
every mobile pane. `apps/web/src/lib/nexus/rows.ts:527,560` additionally promotes
it into blank launcher quick actions and mobile places.

scope correction from owner review: a general recovery destination itself is
unwanted, including under account. ordinary failures should use contextual
feedback and retry toasts. undo belongs to outline editing, not a global list;
successful work does not need retained entries. imports retain their own surface.

proposed fix: retire the activity tray and its entry points after giving each
remaining failure a local presentation owner. use failure toasts for discrete
commands and visible unsaved/retry state in writing surfaces. preserve authored
text, safe retry identity and real loss guards; a disappearing toast cannot own
those. remove global undo retention and routine success feedback deliberately.
do not replace the tray with account badges or another notification centre.

evidence for the required handoff: `components/resources/ResourceComposer.tsx:69-95`
under web source retains save recovery after composer closure;
`lib/notes/useOutlineSession.ts:1176-1212` publishes uncertain saves to the tray.
`lib/notes/writes.ts:3-8,602-613` owns identical retries, uncertainty and bounded
automatic retries independently of presentation.

resolved when no activity destination remains, ordinary failures have contextual
retry, unsaved writing remains visible and protected after toast dismissal, and
imports and outline undo retain their separate purposes. review only; no runtime
change made.
