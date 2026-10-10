# contributors

status: reauthored 2026-10-10 (cleanup/authors-reauthor); behaviour qualified by
the authors harness (campaign artifacts `2026-10-09/authors`).

nexus keeps one canonical person per author and attaches people to works through
ordered, role-typed credits. sources propose credits automatically; the media's
creator may pin the author list by hand. readers follow a name to the person's
works.

## owners

| concept | owner | state |
| --- | --- | --- |
| person | `contributor_writes.create_contributor`, `ensure_alias` | `contributors`, `contributor_aliases`, `contributor_external_ids` |
| credit | `contributor_writes.replace_role_slices` (sole credit DML outside the saved-epub repair) | `contributor_credits` |
| observation | `contributor_taxonomy` (`build_observation`, `ObservedRoleSlices`, `NOT_OBSERVED`) | none |
| author pin | the PUT sets it; `prepare_observed_role_slices_in_current_transaction` honours it | `media.authors_manually_managed` |
| works view | `contributors._WORKS_PLANS`; the web forwards url keys verbatim | url `sort`/`direction` |
| credit staleness | `contributor_writes.bump_credit_revisions` | `viewer_collection_revisions` |
| manual edit (web) | `components/contributors/MediaAuthorsEditor` (load, edit, PUT, reconcile) | rows, notice, mutation id |
| credit presentation (web) | `lib/contributors/credits.ts` | none |

`contributors.py` is the facade every other module calls: search, detail, works,
refs, batch publication, in-transaction publication, prepare/apply, cleanup and
the media-author PUT. it owns sessions, retries and when to invalidate.
`contributor_credits.py` holds the sql fragments and loaders consumers compose
(search, library entries, stats, dossier, suggestions, resource graph, sharing).
the saved-epub repair lives in `epub_contributor_repair.py`, gated on
[its production run](../tickets/epub-contributors-production-repair-pending.md).

## invariants

- I1 visibility: search lists only people with a visible credit
  (`credited_visible_contributor_ids_cte_sql`); detail, works, binding and ref
  resolution use broad visibility (a visible credit or a viewer-owned graph
  edge). unknown and invisible are one answer: 404 `E_NOT_FOUND` on reads,
  `E_AUTHOR_NOT_SELECTABLE` on binding. a malformed handle is 404 before any
  other parameter is parsed. catalogue credits are visible to everyone.
- I2 one row per (target, person, role) and per (target, ordinal): unique
  indexes; `replace_role_slices` dedupes and renumbers through a negative range.
- I3 every person has a resolving alias whose literal equals its display name:
  `create_contributor` ensures it at birth; a changed publication re-ensures it.
- I4 handles match `[a-z0-9]+(-[a-z0-9]+)*`, 3..80; they grant nothing and never
  change. a new person takes `slug≤32-<12 hex of sha256(name key)>` while it is
  free, else that base plus 12 random hex.
- I5 author edits are creator-only, serializable, and replayed per
  `(viewer, "media:{id}:authors", clientMutationId)` over the field-name request
  bytes; another body under a used id is 409 `E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`.
- I6 publication plans the whole roster read-only before any write (prepare) and
  writes on the caller's transaction (apply). prepare rejects a bound handle that
  is missing, combined with a key, or not credited on that media, and, for
  `metadata_enrichment`, a duplicate identity within a role.
- I7 every credit change that alters a works relation advances AuthorWorks, so a
  continuation fails with `E_COLLECTION_CHANGED` instead of skipping or
  duplicating rows.

identity selection: a bound handle names its person; else an existing exact key
wins; else the earliest-created owner of a resolving alias wins unless it already
holds a different key of the same authority, which plans a new, distinct person;
else a new person shared by keyless same-name credits of one batch. an unseen key
is recorded for whoever won. people are never merged or split.

## invalidation

`bump_credit_revisions(db, targets)` runs once per write entry point (once per
200-target chunk in batch publication), only when a row changed. families follow
the target kind, for the viewers who can see a target (`media_viewer_ids_sql`,
`podcast_viewer_ids_sql`):

| target | families | viewers |
| --- | --- | --- |
| media | AuthorWorks, LibraryEntries, PodcastEpisodes | library members and grant holders of the media |
| podcast | AuthorWorks, LibraryEntries, PodcastSubscriptions | subscribers and library members of the show |
| catalogue ebook | AuthorWorks | everyone |

callers keep the bumps they make for their own facts.

## works views

`GET /contributors/{handle}/works` owns four views; the pane forwards the url's
`sort` then `direction` entries and the server rejects anything else with
`E_INVALID_REQUEST` (the pane shows "Invalid works view" + Reset view).

| query, excluding pagination | order |
| --- | --- |
| no `sort` or `direction` | original publication, oldest first |
| `sort=published&direction=desc` | original publication, newest first |
| `sort=title&direction=asc` / `desc` | title a–z / z–a |

publication orders sort by `(date_missing asc, date, title, href)`, so undated
works stay last both ways. cursors are `AuthorWorks:v3`, bound to viewer, handle,
plan and revision: a cursor issued for another binding is 400 `E_INVALID_CURSOR`, and
only then is an issued pair whose collection moved 409 `E_COLLECTION_CHANGED`. podcast works carry role facts and no date ("Publication date
unknown"); catalogue works carry their author credits and no action subject. the
pane loads every page while active, so its count and filter cover all works; a
409 reloads the prefix once, a second surfaces with Retry.

## media authors

`PUT /media/{id}/authors` takes `{clientMutationId, mode: "manual", authors[≤20]
{creditedName, binding: {kind: "existing", contributorHandle} | {kind: "new",
displayName}}}` or `{clientMutationId, mode: "automatic"}` (camel keys only) and
answers `{data: {authorMode}}`. manual replaces the author slice in the sent
order and pins it; automatic releases the pin and keeps the rows until the next
observation. a pinned media withholds automatic author proposals and reports
`retained_manual_authors`. the editor reuses its mutation id while the body is
unchanged and treats a confirmed PUT as the commit point: a failure after it
never re-sends.
