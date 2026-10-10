# a restored pane for deleted media takes down the whole workspace

status: open · origin: 2026-10-04 offline review-fix harness run 2 (journey J7), branch `cleanup/offline-reauthor` · area: hosted workspace / panes

J7 deletes a media (`DELETE /media/{id}`) that the android webview's workspace
had open as a pane. on the next launch, `page.goto(/media/{other})` showed
"Something went wrong in your workspace" instead of the pane, and the journey
timed out waiting for the shelf. webview console:
`Authenticated workspace failed: ApiError: Request failed with status 404`
(`app/(authenticated)/AuthenticatedWorkspaceErrorBoundary.tsx:76`), then on
Retry `CSS length did not resolve to nonnegative pixels: var(--viewport-safe-bottom)`.
the api answered `GET /media/{deleted id}` 404 `E_MEDIA_NOT_FOUND` at the same
moment. J11 (desktop, same account, later) then failed the same way: no
`Account` button, and the api logged `GET /media/{deleted id}` 404 again. run 1
of the same build passed J7 and J11, so it depends on whether the workspace had
persisted the deleted pane. the pre-rewrite harness runs show the same symptom
after J7 (J10 "waiting for getByRole('button', { name: 'Account' })"), so
afaict it predates the offline rewrite. afaict a pane-local not-found is
escalated to the workspace boundary; idk which caller throws, that is the first
thing to establish. the offline vertical does not touch workspace or pane code.

impact: medium. deleting a document on one device (or in another tab) can
blank the whole workspace on the next load of a device that had it open; Retry
fails again.

prerequisite: reproduce: open media X as a pane, delete X through the api,
reload the workspace; capture the throwing request's caller.

fix: a missing resource is that pane's state (not found / removed), never a
workspace defect; repair it where the pane loads its media.

acceptance: the reproduction renders the other panes and a not-found pane for
X; the offline harness J7 passes repeatedly.

2026-10-09 workspace reauthoring (cleanup/workspace-reauthor): the pane
resource-resolution registry, which ran in `WorkspaceHost` outside every pane
boundary and threw same-system failures there, is deleted; a pane's resource is
now its route's own locator and nothing resolves open panes' locators. the
desktop harness journey (J11.deleted-media-in-saved-workspace: open media X,
delete it through the api, reload) passes, but it passed before the rewrite
too, so it does not reproduce the android failure. still needed: the android
webview reproduction above, now without the registry.
