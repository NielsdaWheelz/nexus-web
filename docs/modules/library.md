# libraries

libraries separate personal retention, organization and reading authority. each
account owns one stable default library, presented as all. its physical media
entries retain the account's access. named libraries organize media and followed
shows and share their direct media through membership. system libraries remain
readable and never user mutable. libraries do not own ingestion or asset delivery.

## owners and relations

`services/libraries.py` owns library rows, authority and capabilities, creation,
rename, deletion, destinations and the index. `LibraryAccess` is the capability
owner: `can_manage` requires admin of a named non-system library;
`can_add_content` also includes the viewer's own all. ownership governs delete
and transfer. other members may leave. non-members receive a masked 404.

`services/library_entries.py` is the sole entry writer and canonical membership
owner. its public relations bind `:viewer_id` and a library parameter:

- `library_media_rows_sql` supplies readable media and added/order facts.
  `library_media_ids_cte_sql` is its narrow media-id projection. a named library
  includes direct media plus readable episodes of its filed shows. all includes
  distinct physical media reached through current non-system memberships,
  excluding removal markers and teardown intents. all takes its date from the
  default holding first, otherwise the earliest qualifying physical entry.
- `library_podcast_rows_sql` supplies followed show roots and subscription dates
  for all, and physical show entries for a named library.
- `unfiled_media_ids_sql` includes default-held all media with no direct or
  inherited placement in any current named non-system membership. role and
  ownership do not change this predicate.
- `destination_membership_rows_sql` and `library_anchor_facts` supply suggestion
  inputs; all's media inputs use the same canonical media set.

raw physical show expansion stays private. expansion never grants access or
establishes retention. grant-only, system-only and catalog-only media do not
enter all. search retains its existing containment expansion after canonical
membership. atlas, dossiers and suggestion inputs use all's media set; podcast
search and an explicit all-library podcast filter use its followed show roots.
the unscoped podcast “not in a library” predicate means no named placement.

`services/library_listing.py` owns view lenses, keyset pages, visible named order
and overview counts. all overview, including sort-only changes, folds followed
episodes into their followed show. a concrete media type, `in_progress`,
`completion=unfinished` or `projection=unfiled` exposes qualifying media,
including followed episodes, and no shows. show type plus a media-state or
unfiled predicate is empty. predicates intersect before final sorting and
pagination. overview root counts intentionally differ from media counts.

## retention and locks

explicit capture or media filing atomically retains the actor's default holding
and clears that actor's removal marker. an episode inherited through a filed show
still obtains its default holding without a redundant named episode entry.
unfiling an actual named media entry preserves the actor's eligible default
holding first; an absent no-op acquires nothing. library deletion preserves its
owner's eligible direct media regardless of other holders. incidental
preservation and automatic acquisition respect removal markers and teardown.
show unfiling leaves episode holdings untouched. confirmed show replacement
retains eligible displaced direct episodes and takes their earliest position.
reads, membership changes and grants never acquire holdings.

all writers acquire locks in this order: `users.lock_viewer` when account
serialization is required; admission identity/session; podcast rows; media rows
in uuid order; the complete library set in uuid order. the viewer primitive uses
`FOR NO KEY UPDATE`, permitting foreign-key key-share locks. provider and storage
i/o stay outside these transactions. low-level physical entry helpers never take
a viewer lock. the media reference barrier excludes concurrent teardown.

entry positions order each library; gaps are legal. entry identities and dates
survive reorder. each physical change advances `libraries.order_revision` from
`collection_order_revision_seq`. every accepted named intent also advances,
including already-present, already-absent and inherited no-ops. revisions are
positive decimal strings on the wire, compared exactly.

## placement and acquisition protocol

all JSON responses below use `{data: ...}`. destination and placement envelopes
read their removal fence, rows, capabilities and revisions in one SQL snapshot.
default libraries never appear as organizational choices.

| route | contract |
| --- | --- |
| `GET /libraries/destinations` and `/extension/library-destinations` | `{removal_revision,destinations:[{id,name,order_revision}]}`; complete named admin destinations, ordered by name |
| `GET /libraries/placements/{media:<id>\|podcast:<id>}` | `{removal_revision,placements:[{library_id,name,relation,blocked,order_revision}]}`; named placements only |
| `PUT /libraries/{id}/items/{ref}` | `{included,expected_order_revision,expected_removal_revision,replace_episodes}` → authoritative placement; inclusion requires removal revision, exclusion requires null |
| `POST /libraries` | `{id,name,initial_items,expected_removal_revision}` → 201 `LibraryOut`; empty creation requires `[]` and null; create-and-file requires the removal fence |
| `GET /libraries/{id}/entries` | `sort`, `entry_type`, `projection`, `completion`; `{items,next_cursor,order_revision}`; structural revision only on unfiltered named manual order |
| `GET /libraries/{id}/order` | complete visible `{entry_ids,order_revision}` for a mutable library |
| `PUT /libraries/{id}/entries/{entry_id}/position` | `{before_entry_id,expected_order_revision}`; null successor means last; exact captured revision and visible identities required |
| `PATCH /libraries/{id}` | `{name,expected_name}`; already desired name succeeds, changed predecessor conflicts |
| `DELETE /libraries/{id}` | owner only; absent or invisible is idempotent success |

placement relations are `Direct`, `Inherited` and `Absent`; blocks are
`RequiresAdmin`, `RequiresSubscription`, `SystemManaged` or null. inherited
inclusion succeeds. inherited exclusion conflicts with “included through its
show”. a show needs a subscription when newly added, while an existing named
show can be removed after unsubscribing. replacing direct episodes requires
`replace_episodes`; the unchanged captured revision also fences confirmation.

commands lock the complete set, recheck visibility and authority, then compare
the exact revision BEFORE desired-state equality. stale intent receives 409
`E_RESOURCE_CONFLICT` without effects. strict retries retain their frozen guards
and may conflict after landing. create retries reuse their client-minted id:
the same owner receives the existing row and initial items are never reapplied;
another owner's id conflicts. library deletion also advances the acquisition
fence, so a frozen create-and-file retry cannot recreate the deleted library.
ordinary empty creation has no acquisition fence; its receipt lasts only while
the library row exists. complete selections validate atomically; selected
media are retained, then shows are filed before episodes, independent of input
order. duplicate refs and default/system destinations are refused.

`users.removal_revision` fences acquisitions: explicit workspace removal, library
deletion and unsubscribe advance it even for accepted absent no-ops; acquisition and sync do
not. an acquisition supplies `{expected_removal_revision,destinations:[{
library_id,expected_order_revision}]}`. callers serialize the viewer before
identity/podcast/media locks; `validate_acquisition_destinations` locks the
complete default and named set and validates every fence before effects.
`finish_acquisition_destinations` advances accepted destination no-ops. stale
acquisition rolls back publication, retention and all requested filing. durable
source/upload receipts return their past identity while the receipt survives,
without reapplying effects;
current availability and placements govern what the client displays.

assistant filing uses the same guarded command and owns undo only for its exact
new named entry. receipts carry the final `order_revision`. history and execution
share `library_entry_undo_eligible`: current admin authority, mutable named library,
exact entry identity and exact receipt revision are all required. reaffirmation
invalidates earlier undo. undo retains default holdings. historical entry receipts
carry null revision: provenance survives, but undo authority was never proved.

## interaction and adjacent owners

web `lib/libraries/api.ts` owns typed calls and change publication.
`placementController.tsx` owns account-scoped per-library serialization, frozen
commands, per-target outcomes and unknown recovery. only an acknowledged local
predecessor may supply a revision to its pending dependent choice; external changes
require a fresh explicit choice. closing the picker preserves accepted work.
create-and-file uses the atomic create endpoint. chooser and destination fields
present named libraries only; zero selections is valid. all launches the existing
add panel with no named destinations. library choices and pending placement or
acquisition commands remain with their memory owners; the writing journal has
its separate [notes](notes.md) contract.

`services/library_members.py` owns memberships, invitations, leaving and transfer,
authorized through `LibraryAccess`; ordinary membership changes capture nothing.
member loss removes future passive shared access, while explicit and migrated
personal holdings survive. [resource sharing](resource-sharing.md) owns grants.
dossiers and [suggestions](suggestions.md) retain their own generation
and observation lifetimes. [player](player.md) owns lectern order and consumption.

## chooser presentation

`LibraryChooser` shares the [collection and search contract](visual-system.md#collections-and-searchable-pickers).
first available existing results highlight automatically; creation requires
deliberate selection. matching filters every row, including current memberships.
accepted actions retain the query, focus and valid active identity.

normal placement rows show the exact name and confirmed membership mark. draft
destination marks mean chosen for that request. mixed counts, inherited/read-only
reasons, progress and recovery remain explicit; highlight never means membership.
all and system libraries are absent from the named organizational projection.
the revision-fenced placement owner retains accepted work and recovery across
view closure; collection primitives own neither commands nor settlement.
