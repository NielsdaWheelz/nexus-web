# browse deep link restores an old pane

a supported browse entry can restore the previous media pane and replace its
url, preventing discovery/preview through that link. ordinary primary navigation
is a distinct path; passing it does not resolve this entry defect.

observed at `329391ff0`'s unchanged workspace code: after existing media/lectern
panes, navigate to `/browse?q=The%20History%20of%20Rome&kind=Podcast&source=PodcastIndex`.
the request returns200 html, but the resulting frame returns to the old
`/media/{id}` with no `/api/browse` request. the query is accepted by
`readBrowseQuery`; `docs/modules/workspace.md:65` and
`apps/web/src/lib/workspace/model.ts:103` define canonical deep-link admission.
cause is not yet established.

repair the workspace entry/admission owner; do not add a browse/player redirect
or bypass. resolved when this supported entry activates browse with its actual
query while preserving other panes and guarded work, including on reload.
