# libraries

libraries separate personal retention, organization and reading authority.
`services/libraries.py` owns rows, membership capabilities and library lifecycle;
`library_entries.py` is the sole physical entry writer and canonical membership
owner. system libraries are readable and never user mutable.

## membership and retention

an account has one stable default library, presented as all. its physical media
entries retain personal access. all lists distinct physical media reached through
current non-system memberships, excluding removal markers and teardown intents.
its added date comes from the default holding, otherwise the earliest qualifying
entry. named libraries organize and share direct media. grants and reads acquire
no holdings. unfiled means default-held media without a direct named placement.

entries contain only media. podcast subscriptions are independent rules, read in
a separate section above contents; they never fold episodes or enter media sort,
counts, order or paging. [podcasts](podcast.md) owns their admission and scoped stop.

explicit media capture/filing retains the actor's default holding and clears that
actor's removal marker. named unfiling preserves the actor's eligible holding
first; an absent no-op acquires nothing. library deletion preserves the owner's
eligible direct media. incidental retention respects suppression and teardown.
background named podcast delivery belongs to its library and acquires no former
initiator's personal holding. global podcast removal bypasses ordinary unfile
preservation to remove every selected placement without recreating holdings.

`LibraryAccess` owns capabilities: `can_manage` requires named non-system admin;
`can_add_content` also admits the viewer's own default. owners delete/transfer;
other members may leave. nonmembers receive a masked 404. default libraries never
appear among organizational destinations.

## writes and locks

writes acquire viewer serialization when needed, then admission identity, sorted
podcast aliases, shows/runs, media in uuid order and the complete library set in
uuid order. the viewer lock is `FOR NO KEY UPDATE`. physical reference acquisition
uses the existing media tuple barrier before library locks. no provider/storage
io occurs in these transactions; low-level physical writers never take viewer locks.

`libraries.order_revision` comes from `collection_order_revision_seq`; every
physical change and accepted named intent advances it, including present/absent
no-ops. wire revisions are exact decimal strings. commands validate authority and
captured revision BEFORE desired-state equality. stale intent is 409 without
effects. frozen retries may conflict after landing; fresh review is explicit.

`users.removal_revision` fences acquisition. workspace removal, library deletion,
podcast stop and import cancellation advance it; acquisition/sync do not. ordinary
`validate_acquisition_destinations` locks default plus all selected named libraries
and checks every fence; default remains ineligible as an organizational target.
podcast admission narrowly permits its actor's default through the same owner.

| command | contract |
| --- | --- |
| `PUT /libraries/{id}/items/media:{id}` | absolute `included`, exact `expected_order_revision`; inclusion requires `expected_removal_revision`, exclusion requires null |
| `POST /libraries` | client id, name, `initial_items`, removal fence; empty create uses `[]` and null. create-and-file is atomic; replay never reapplies initial items |
| `GET /libraries/destinations` | one snapshot `{removal_revision,destinations}`; complete named admin destinations |
| `GET /libraries/placements/media:{id}` | one snapshot `{removal_revision,placements}`; named direct/absent relations and capabilities |
| `GET /libraries/{id}/entries` | intersected media sort/type/projection/completion, then keyset paging; structural revision only for unfiltered named manual order |
| `GET /libraries/{id}/order` | complete visible entry ids and revision |
| `PUT /libraries/{id}/entries/{entry_id}/position` | exact revision, nullable successor; preserves entry identity/date |
| `PATCH /libraries/{id}` | name plus expected predecessor; already desired succeeds |
| `DELETE /libraries/{id}` | owner only; idempotent. retain eligible media, fence acquisition and clear podcast rules/imports/runs explicitly |

create retry returns the same owner's extant row; another owner's id conflicts.
deleted libraries cannot be recreated by stale create-and-file. empty-create
receipts last only while their row exists. no generic replay ledger exists.

assistant media filing shares this guarded command; undo requires the exact new
entry id and receipt revision plus current authority. reaffirmation invalidates
undo; default retention survives it. historical show receipts carry provenance
without mutation authority. assistant podcast admission requires explicit mode and
uses the podcast owner, with no generic filing undo.

## composition

web `lib/libraries/api.ts` owns calls/change publication; `placementController`
owns account-scoped per-library queues, frozen commands and unknown recovery.
only acknowledged local predecessors may supply dependent revisions. external
changes require a new choice. closing presentation preserves accepted work.

canonical media/show relations feed search scopes, atlas, dossiers and suggestions.
`library_listing` owns media lenses and paging. `library_members` owns invitations,
leaving/transfer; passive membership changes acquire nothing. resource grants,
consumption and suggestions retain their own owners.

## publication presentation and order

index publication means `original_published_date`, displayed as its four-digit
year with the complete partial calendar value retained in `time`. full metadata
retains precision, edition dates and complete role-grouped credits. external
discovery does not assert first publication; its observed instant appears only in
preview details, labelled `source published` in the viewer's render environment.
the [index shell](resource-references.md#presentation-contract) owns density.

`published_asc`/`published_desc` order by the complete supported original calendar
value, nulls last in either direction, then title/id. partial values retain their
existing deterministic ordering without asserting invented days. feed timestamps
never substitute. fresh library playback snapshots share this query; durable
queues keep their recorded order. publication keyset plans name the original-date
columns, so prior publication-plan cursors are invalid and require a fresh list
read. public sort names and wire shapes remain unchanged. explicit episode/source
release views retain release chronology.

## chooser presentation

`LibraryChooser` shares the [collection and search contract](visual-system.md#collections-and-searchable-pickers).
first available existing results highlight automatically; creation requires
deliberate selection. matching filters every row, including current memberships.
accepted actions retain the query, focus and valid active identity.

normal placement rows show the exact name and confirmed membership mark. draft
destination marks mean chosen for that request. mixed counts, read-only
reasons, progress and recovery remain explicit; highlight never means membership.
all and system libraries are absent from the named organizational projection.
the revision-fenced placement owner retains accepted work and recovery across
view closure; collection primitives own neither commands nor settlement.

podcast libraries reuses this search/create presentation and creation transport,
with an account-owned creation helper scoped by the frozen show target. pending
names are shared across scopes; status, refusals and uncertainty remain scoped.
the manager creates an empty library before a separate subscription review.
creation is never rolled back when that review is cancelled. media placement's
late-acquisition continuation does not participate.
