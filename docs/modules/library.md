# libraries

libraries separate personal retention, organization and reading authority.
`services/libraries.py` owns rows, membership capabilities and library lifecycle;
`library_entries.py` is the sole physical entry writer and canonical membership
owner. system libraries are readable and never user mutable.

## membership and retention

an account has one stable default library, presented as all. its physical media
entries retain personally. all lists the distinct union of physical media in
current non-system member libraries, including those personal holdings. teardown
and document removal markers retain their existing exclusions; canonical episodes
have no personal hiding marker. all's added date comes from the default holding,
otherwise the earliest qualifying entry. named libraries organize and share direct
media. grants, catalogue access and reads acquire no holdings. unfiled means
default-held media without a direct named placement. placement snapshots expose
effective union membership as `all_membership.included` and physical personal
retention as `all_membership.retained`; effective all membership alone does not
prove personal retention.

entries contain only media. feed subscriptions are independent rules, read in
a separate section above contents; sources never fold entries or enter media sort,
counts, order or paging. the rule requires every known entry as a physical
membership in its exact library and delivers later discoveries there.
[feeds](feeds.md) owns admission, finite work and scoped stop; the library
writer owns all resulting memberships.

explicit individual media capture/named filing retains the actor's default
holding; document filing also clears the actor's removal marker. named unfiling
preserves the actor's eligible holding first; an absent no-op acquires nothing.
library deletion preserves the owner's eligible direct media. document incidental
retention respects suppression and teardown.

bulk feed addition and automatic delivery file only their chosen destination.
choosing a named library creates no personal holding. individual episode
`add to all` explicitly files the real default library; open/play/tools never save.
while a library/source rule is active, individual unfiling and assistant filing undo
refuse with `E_FEED_SUBSCRIPTION_ACTIVE`. all-removal refuses any contributing
rule, including a read-only shared rule.

feed unsubscribe/cleanup removes only reviewed placements after removing rules
and fencing affected work. named cleanup preserves existing personal and other
holdings without manufacturing default retention; all-removal removes every
reviewed placement. catalogue identities, authored work, transcripts, listening
state/settings, queue/lectern and device downloads survive. episode removal writes
no hiding marker and does not change annotation or grant ownership.

`LibraryAccess` owns capabilities: `can_manage` requires named non-system admin;
`can_add_content` also admits the viewer's own default. owners delete/transfer;
other members may leave. nonmembers receive a masked 404. default libraries stay
outside named organizational destinations. podcast addition offers personal all as
an explicit destination alongside writable named libraries.

inspection uses `GET /libraries/{id}/metadata`: the native kind, viewer role,
record timestamps and full visible physical media count. personal consumption and
[collection lectern actions](collection-actions.md) require reading authority,
not administration. libraries never nest through these actions. leaving uses the
existing membership owner and appears in the shared resource menu when eligible.

## writes and locks

writes acquire viewer serialization when needed, then admission identity, sorted
podcast aliases, shows/runs, media in uuid order and the complete library set in
uuid order. the viewer lock is `FOR NO KEY UPDATE`. physical reference acquisition
uses the existing media tuple barrier before library locks. no provider/storage
io occurs in these transactions; low-level physical writers never take viewer locks.

`libraries.order_revision` comes from `collection_order_revision_seq`; every
physical change and accepted placement intent advances it, including present/absent
no-ops. wire revisions are exact decimal strings. placement, move and lectern
commands validate authority and captured revision BEFORE desired-state equality: a
toggle depends on what was reviewed. stale intent is 409 without effects. frozen
retries may conflict after landing; fresh review is explicit. acquisition compares
no order revision: appends commute, so no addition is refused for another's insert,
and only an actual insert advances the revision.

`users.removal_revision` fences acquisition. workspace removal, library deletion,
podcast stop, accepted episode removal and import cancellation advance it;
acquisition/sync do not. an inert already-absent episode retry returns the current
revision without a new write. ordinary `validate_acquisition_destinations` locks
default plus all selected named libraries, requires admin authority over each named
one and compares the removal fence. podcast bulk admission files one fenced
destination. the placement route permits supported media inclusion in the actor's
actual default, including canonical episodes; default exclusion remains forbidden.

`media.acquisition_revision` uses the same monotone sequence under the media lock.
explicit acquisition/filing, including no-ops, accepted part restoration and source
supersession transfer advance it; implicit retention and reads do not. generic
workspace removal freezes this revision in `GET /media/{id}/removal-preview` and
requires `expected_acquisition_revision` on deletion. a visible mismatch refuses
409 before effects; an already unavailable item answers 204. an open review never
refreshes its guard. the revision is global to the media, so another viewer's save
can require a new review. podcast removal retains its separate scoped contract.

| command | contract |
| --- | --- |
| `PUT /libraries/{id}/items/media:{id}` | absolute `included`, exact `expected_order_revision`; inclusion requires `expected_removal_revision`, exclusion requires null; own-default inclusion permits supported media |
| `POST /libraries` | client id, name, `initial_items`, removal fence; empty create uses `[]` and null. create-and-file is atomic; replay never reapplies initial items |
| `GET /libraries/destinations` | one snapshot `{removal_revision,destinations}`; complete named admin destinations |
| `GET /libraries/placements/media:{id}` | one snapshot `{removal_revision,all_membership,placements}`; actual default id/revision, effective all inclusion, physical retention and aggregate removal blocker; named direct/absent relations and exact-rule blockers |
| `GET /libraries/{id}/entries` | complete intersected media view plus library and podcast section in one snapshot; structural revision only for unfiltered named manual order |
| `GET /libraries/{id}/order` | complete visible entry ids and revision |
| `PUT /libraries/{id}/entries/{entry_id}/position` | exact revision, nullable successor; preserves entry identity/date |
| `PATCH /libraries/{id}` | name plus expected predecessor; already desired succeeds |
| `DELETE /libraries/{id}` | owner only; idempotent. retain eligible media, fence acquisition and clear podcast rules/imports/runs explicitly |

create retry returns the same owner's extant row; another owner's id conflicts.
deleted libraries cannot be recreated by stale create-and-file. empty-create
receipts last only while their row exists. no generic replay ledger exists.

assistant media filing shares this guarded command; undo requires the exact new
entry id and receipt revision plus current authority and no active exact-library
podcast rule. reaffirmation invalidates undo; default retention survives it.
historical show receipts carry provenance without mutation authority.
assistant podcast admission requires explicit mode and
uses the podcast owner, with no generic filing undo.

## composition

web `lib/libraries/api.ts` owns calls/change publication; `placementController`
owns account-scoped per-library queues, frozen commands and unknown recovery.
only acknowledged local predecessors may supply dependent revisions. external
changes require a new choice. closing presentation preserves accepted work.

the hosted placement picker captures its stable opener's containing modal at
open and retains it when external media becomes stored. departure of that exact
modal retires the ui session and its retarget handle; temporary coverage does
not. accepted placement commands and destination creation keep their account
lifetime. page openers have no parent modal.

library settings retains one unanswered rename or delete in its existing overlay
draft. an unavailable read may mean lost membership and cannot settle that command;
its exact retry and loss guard remain reachable. opposite writes wait, while words
remain editable and copyable between attempts. rename retries retain the original
name and expected name; delete retains its absolute id. an actual delete reply
acknowledges the idempotent operation, including invisible absence, and does not
prove physical deletion. accepted guarded close abandons that entry's local draft.

member commands and invitation answers retain one immutable command in their
pane visit's resource draft. original controls cannot replace it while running or
unanswered; the held retry uses the same ids, body and expected role. inspector
closure, filtering and loss of the management body preserve that owner. local
confirmation dismissal changes presentation only; running alone paints busy.

fresh opposite lists do not settle uncertainty. invitation answers settle on an
acknowledgement or typed terminal invitation result. member desired-state proof
requires fresh complete authorized lists and the exact subject; remove/revoke
absence alone is insufficient. a receipt proves that request accepted, and a
desired-state read proves the current postcondition. neither permanently fences
a separate still-running role or transfer command: those writers compare mutable
values, not monotone revisions.

canonical media/show relations feed search scopes, atlas and suggestions.
`library_listing` owns complete media lenses and their atomic pane aggregate. `library_members` owns invitations,
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
queues keep their recorded order. complete publication order plans name the original-date columns and also serve
ordered command selections. explicit episode/source
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
the import destination chooser separately shows an unselectable `All / always`
row, including while filtered: acquisition always files there.
the revision-fenced placement owner retains accepted work and recovery across
view closure; collection primitives own neither commands nor settlement.

the podcast addition manager reuses this search/create presentation and creation
transport, with an account-owned creation helper scoped by the frozen show target.
it includes personal all, writable named libraries and confirmed read-only rules;
all addresses the actual default uuid. destination selection precedes a separate
`podcast` or once-only `episodes` review. existing checked rules review unsubscribe;
new once additions are unavailable in subscribed destinations. the primary rss
subscribe action keeps its personal-default behavior.

pending names are shared across scopes; status, refusals and uncertainty remain
scoped. creation acknowledges an empty library before addition review and survives
its cancellation. choosing a destination or mode creates no placements or rule.
media placement's late-acquisition continuation does not participate.
