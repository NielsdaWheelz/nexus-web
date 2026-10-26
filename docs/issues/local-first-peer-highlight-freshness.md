# open readers still need peer annotation invalidation

own highlights come from the local authored store; readable peers' highlights
come from the separate server document map. the backend cutover is wired:
`services/authored/projections.py` calls `highlights.annotations_changed`, the
readable audience's annotation lanes advance, and `/stream/writing` exposes the
changed `annotations_revision`. real postgres case 3c passes repeatedly,
including lab43 (`9836f73b6`). this proves server admission and invalidation only.

the current browser hint owner (`lib/authored/hints.ts`) discards stream data and
only wakes replication. a peer change has no own authored feed entry. the open
map owner (`media/[id]/annotations.ts`) rereads on initial subscription, changed
source identity or explicit refresh; local adjacency/backlink subscriptions only
refresh links. no client currently consumes the annotation token. a peer's
create/edit/delete can therefore remain stale in an already-open reader.

the client repair now carries the required opaque token on ordinary authored pull
responses and emits a dedicated remote-annotation event; it does not persist the
token, advance a writing watermark, invalidate own queries or add polling.

one related read-owner defect is repaired in the same path: `project` previously
replaced a failed remote read with ready cached wire, hiding its failure/retry ui.
a consumed token supplies no second same-token event. projection now preserves
the failed/retrying state and old visible marks until a successful read explicitly
publishes ready; manual retry remains available. no additional lifecycle owner
is introduced. these repairs await the actual open-reader proof.

resolved when a real shared-library peer changes a highlight while the reader
stays open, and the remote map refreshes independently of local writing, including
reconnect and the installed client. a owns the browser red and client repair;
no further backend change is established as necessary.

actual mounted red on `dc4467ee3`, lab `20261025-191710-26f7763b06b3`: the initial remote map settled empty; a real peer writer created the blue passage highlight without advancing the viewer’s authored head or entering their corpus. no peer paint appeared within 45 seconds. the candidate passes static checks; live green and packaged-native freshness remain pending.
