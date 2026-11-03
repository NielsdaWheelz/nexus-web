# root and pane notice frames can cover a tucked restore tab

problem: a plain refusal row can overlap the restore tab for a different tucked
unanswered command. moving onto the tab holds the covering row under the pointer,
so its expiry does not make that recovery usable. retained command ownership alone
does not satisfy reachable recovery.

evidence at14400e332: actual canonical run20261103-032015-1117f97ec4c4,
SourceRefresh-chromium-failure and MetadataResearch-chromium-failure artifacts.
both journeys reached unknown, pane closure, exact409 retry, tuck and8.5s no-send;
the15s restore click failed because the Plain row intercepted pointer events.
whole aria still contains the held command and restore control.
`apps/web/src/components/feedback/Slips.module.css:68` places frame above tab;
`Slips.tsx:326` uses disjoint modalGroup slots only for modal rooms.

fix at the shared stage placement owner: Root and Pane frames and their restore
controls need disjoint visible hit targets too. reuse the existing group/geometry
contract, preserve held-pointer stability and no reserved document space. do not
mask it with a media-specific close-before-restore workaround.

resolved when: both engines can restore a tucked unanswered command while an
ordinary refusal row remains, with a real pointer, in Root/Pane and modal rooms.
verify narrow viewport and held-frame arrivals remain usable. media ownership
may be characterized separately by deliberately closing the plain notice, but
that is not proof of this placement repair.
