# hidden highlight can leave an unreferenced x post stored

a semantic highlight deletion correctly removes its retained-x-post read grant,
but the authored projection does not yet ask the media owner to collect the source
when that was its final retainer. its bytes can therefore linger unreadable.

impact: storage retention regresses; there is no reading-permission expansion or
loss of the saved quote/canonical annotation. source copies and passage references
keep their existing independent retention rules.

evidence: `python/nexus/services/authored/projections.py` hides the highlight and refreshes contributor
visibility; `python/nexus/auth/permissions.py` excludes hidden highlight roots. the oldserver
backend case review identified the missing media teardown request after the final
highlight becomes hidden.

resolve by composing the existing media-family lock/teardown owner in the declared
head-before-media-before-projection/keyword order. do not take a media lock after
keyword publication or delete authored captures to recover the old physical-delete
path. verify final-retainer deletion, another live highlight/passage retainer,
revival and retained independent notes/quotes on real storage.

status: the media owner exposes `media_deletion.lock_highlight_sources` (under the
head, before projection/keywords) and `release_highlight_sources` (after projection;
claims only a final-retainer source); the authored projection calls both and
`_references` ignores grants on hidden highlights. disposable case 3d in
`apps/web/.nexus-lab/cases/backend_cutover.py` passes on real postgres. remaining
proof: root's canonical lab run showing the teardown job removes the stored objects
while a live retainer elsewhere keeps them.
