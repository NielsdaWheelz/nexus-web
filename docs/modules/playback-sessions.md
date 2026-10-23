# playback sessions

playback owns an occurrence sequence and cursor per device. consumption owns
progress, reset fences and completion; the lectern owns intended consumption.
queue entries carry only occurrence and media uuids. they neither retain media
nor authorize playback. unavailable references keep their positions; activation
reads the current consumption descriptor.

`schemas/playback_sessions.py` owns the wire. an occurrence id is unique within
a queue and cannot change its media under that queue identity. repeated media
ids are intentional. current names one occurrence or is null; nonempty plus
null means exhausted. provenance captures the source once and is immutable
under a queue identity. replacement, clear and undo mint a new queue identity.
the queue is bounded at 10,000 occurrences; overflow is `E_LIMIT`, never truncation.

`services/playback_sessions.py` owns `playback_sessions`. `id` is client minted;
`(user_id, device_id)` is unique, with device identity supplied by the bff's
`X-Nexus-Device` from its httponly cookie. reads return only this device's row;
absence is null. there is no other-device fallback. clearing keeps the row and
its revision. account deletion cascades its rows through the user foreign key;
there are no media foreign keys or media-deletion cascades.

`GET /me/playback-session` returns `Data[BrowserSessionOut | null]` with
`Cache-Control: no-store`. `PUT /me/playback-session` accepts absolute
`{id, expected_revision, state, terminal}` and returns the acknowledged session.
first creation uses `INSERT ... ON CONFLICT DO NOTHING`, requires null expected
revision and starts at revision `1`. an identity held by another account/device
or a competing row for this device is `E_RESOURCE_CONFLICT`.

writes lock viewer then session in a serializable transaction. already-present
desired state is inert success; otherwise the captured revision must match.
new occurrences must name visible playable episodes. unchanged occurrences can
remain unavailable. saved malformed state is a defect, never absence.

terminal puts name the ended occurrence and its real listening sample. they
preserve queue identity, entries and source, move from that current occurrence
to its successor or exhausted null, and compose consumption's
`settle_natural_end_in_txn` in the same transaction. both the browser put and
native natural-end route use that consumption owner. a stale terminal retry
only succeeds when desired queue state AND consumption's postcondition hold:
finished override at expected plus one (null means zero), matching reset epoch,
and no lectern membership. inspection never reapplies completion or removal;
a later unread, reset or re-add wins. queue-only readback cannot settle terminal
uncertainty.

`services/playback_snapshot.py` owns `POST /playback/snapshot`, a read-only
repeatable-read capture of a library/podcast request plus selected media id.
the listing owners expose complete membership in their existing total order;
capture never walks live cursors. libraries contribute physical media memberships
only; their separate podcast subscriptions section never expands into episodes.
library entry types are media kinds, never podcast rules. migration
`0312_playback_sessions` follows `0311_chapter_end_provenance` and starts with no saved
queues. text matching trims with
javascript's whitespace set, nfc-normalizes and lowercases the query, then
substring-matches title and all credited/canonical author names with the same
normalization. this is explicitly unicode 15.0, owned by the pinned python 3.12
runtime. browser `paneFilterText` shares it using frozen unassigned, cased and
case-ignorable sets from unicode 15.0: newer characters stay opaque; native nfc
and scalar lowercase run only on assigned segments, and final sigma uses the
frozen properties. supported browsers must implement unicode 15 nfc/casing.
the generated data records its normative source urls and sha256 values. capture filters playable episodes independently of transcript
readiness. its response freezes resolved source label, normalized query and
all matching media ids. an absent selected item refuses the whole start with
`E_RESOURCE_CONFLICT`; inaccessible sources are 404. captures do not install
queues or retain descriptor authority.
