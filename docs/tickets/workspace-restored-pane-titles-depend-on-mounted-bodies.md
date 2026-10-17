# restored pane titles depend on mounted bodies

status: open; source-confirmed, device reproduction pending.
origin: 2026-10-16 mobile command palette design review.
area: workspace / resource identity.

problem: restoring a mobile workspace can leave inactive media tabs labelled
`Media` indefinitely. the runtime title map starts empty
(`apps/web/src/lib/workspace/store.tsx:133–138`); an absent publication uses the
route default with `labelState: "pending"` (`store.tsx:626–637`). mobile mounts
only the active pane (`components/workspace/WorkspaceHost.tsx:65–72`). media
titles are published by the mounted reader after its detail read
(`app/(authenticated)/media/[id]/MediaPaneBody.tsx:97–112`). saved visits contain
only id/href (`python/nexus/schemas/workspace_session.py:27–29`). the nexus
projection discards pending state (`components/nexus/useNexusController.ts:83–90`).
web paths above are relative to `apps/web/src`.

impact: multiple resources become indistinguishable before opening them;
searching open panes by their actual titles also loses local matches. changing
row css cannot repair the missing identity.

the ownership gap also affects other dynamic routes. returning to a media pane
can erase an already-known body title during its new detail read: the body
publishes null, and `store.tsx:480–493` removes body publications while preserving
link hints. duplicate panes have separate publications for the same resource.

hint quality is also uncontrolled: `lib/panes/targetLinkActivation.ts:97–105`
uses a menu anchor's text as `labelHint`. a command label such as `open in new
tab` can become a resource's display name. explicit semantic hints and canonical
titles must be distinguished from action copy before hints become durable.

reproduce: open several distinctly titled media panes, persist the workspace,
reload at mobile width, then open nexus before visiting the inactive panes.
compare labels before and after opening each pane. this path is established by
source inspection; no fresh physical-device run was performed in this review.

prerequisites: define one resource-title read contract independent of reader
mounting, including pending, unavailable and refresh states.

proposed fix: one narrow workspace presentation batch reads canonical identity
through existing domain visibility/credit owners, independently of the seeded
media-summary cache. preserve live page/note text ownership, including uncreated
notes, and text-version precedence. publish committed note acknowledgement and
contributor metadata invalidations; reuse existing chat invalidation. keep bounded,
route-bound last-known display hints for restoration, particularly external
previews whose sealed targets contain no title. propagate pending/error state
into every pane selector. keep optional resolution below a local error boundary;
do not mount inactive readers or fetch full documents to obtain titles. the
[mobile palette plan](../mobile-command-palette-plan.md) states the tradeoffs.

acceptance: cold mobile restore names every accessible open resource without
mounting it; rename and route changes cannot publish stale titles; transient
failure is visible and retryable; removed resources are explicitly unavailable;
tabs and nexus consume the same presentation owner. hints contain resource
identity, never menu command copy; live unsaved notes survive missing server
rows; a stale read cannot overwrite newer acknowledged text or its saved hint.
