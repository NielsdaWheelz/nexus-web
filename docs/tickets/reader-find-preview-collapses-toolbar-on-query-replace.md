# reader find preview collapses toolbar on query replace

status: open
origin: 2026-10-02 metadata enrichment browser acceptance; pre-existing in base
area: reader / pane search

from a bare article url, open more → find and enter a matching phrase outside
the viewport. preview reaches the paragraph and retains the held reading spot,
but the find toolbar closes, preventing continued stepping/refinement until
reopened. root reproduced this in the fresh `metadata-final` browser; no errors.

`MediaPaneBody.tsx:2038–2040` delegates find to mounted navigation; the web locator
path at `:2879` replaces the href with `?fragment` via `:542–544`.
`lib/panes/paneIdentity.ts:23–25` retains queries in the route key, while
`components/workspace/PaneShell.tsx:315–320` fences find expansion to its opening
route key. these paths are unchanged from the base; navigation does not explicitly
dismiss find. full paths are under `apps/web/src`; the pane is
`app/(authenticated)/media/[id]/MediaPaneBody.tsx`.

prerequisite: decide same-document find continuity at the existing pane-search
owner. keep expansion through reader-owned location replacements without
retaining stale search across a different resource/visit. do not fix this in
metadata refresh or add pane-history entries for find previews.

acceptance: from a bare article url, preview a match, step and refine the query
with the toolbar still open; held-spot return remains correct. navigating to a
different resource still closes/fences the old search.
