# quick pane return: confirm the eye-line anchor past the collection row

status: open (fix landed, acceptance pending) · origin: 2026-10-10 authors reauthor (cleanup/authors-reauthor), harness X8; fix 2026-10-10 workspace host reauthor (cleanup/workspace-host-reauthor) · area: workspace / pane return

the bug: `usePaneReturnScrollport` registered `scrollport.firstElementChild` as
the anchor root, which is the collection row when one is shown, so a quick Back
to a long collection fell back to the raw `scrollTop` and, with rows that come
back at other heights (`ResourceList` content-visibility), landed the eye-line
row 200-600px low (authors harness X8; U6 with a 1.5 s dwell was exact).

the fix: `PaneShell` wraps the route's content in `.routeContent` and passes it
as `contentRef`; the memento anchors there
(`apps/web/src/lib/workspace/paneReturnMemento.tsx`, `usePaneReturnScrollport`).

why still open: the host harness ports X8/U6 onto its only long collection, the
Libraries list (H-S8, both within 1px), but those rows keep their heights, so it
passes with or without the fix. the authors fixture (an author with 100+ works)
is not in that stack.

acceptance: authors harness X8.quick-pane-return-restores-scroll passes against
this build (its `activePane` helper must use `[data-pane-shell][data-active="true"]`:
the pane wrap no longer carries `data-active`), and U6 still passes.
