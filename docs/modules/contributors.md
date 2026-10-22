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
| manual edit (web) | `components/contributors/MediaAuthorsEditor` (load, edit, PUT, reconcile) | rows (a new person's minted id), notice |
| credit presentation (web) | `lib/contributors/credits.ts` | none |

`contributors.py` is the facade every other module calls: search, detail, works,
refs, batch publication, in-transaction publication, prepare/apply, cleanup and
the media-author PUT. it owns sessions, retries and when to invalidate.
`contributor_credits.py` holds the sql fragments and loaders consumers compose
(search, library entries, stats, dossier, suggestions, resource graph, sharing).

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
- I5 author edits are creator-only, serializable and absolute (last writer
  wins): a resend applies the same list again. a new person takes the client's
  id, so a resend that landed binds the person it created (if visible, else 422
  `E_AUTHOR_NOT_SELECTABLE`) instead of creating another.
- I6 publication plans the whole roster read-only before any write (prepare) and
  writes on the caller's transaction (apply). prepare rejects a bound handle that
  is missing, combined with a key, or not credited on that media, and, for
  `metadata_enrichment`, a duplicate identity within a role.
- I7 works page under the keyset guarantee (architecture §8.12): a credit
  change moves rows across an open continuation without failing it; the tab
  that made it rereads (the media query revision).

identity selection: a bound handle names its person; else an existing exact key
wins; else the earliest-created owner of a resolving alias wins unless it already
holds a different key of the same authority, which plans a new, distinct person;
else a new person shared by keyless same-name credits of one batch. an unseen key
is recorded for whoever won. people are never merged or split.

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
works stay last both ways. cursors bind viewer, handle and view (`AuthorWorks`,
architecture §8.12): a cursor issued for another binding is 400
`E_INVALID_CURSOR`. podcast works carry role facts and no date ("Publication date
unknown"); catalogue works carry their author credits and no action ref. the
pane drains every page while active (`useServerList`), so its count and filter
cover all works; a failed continuation keeps the rows and offers Retry, a
rejected cursor Refresh list.

## media authors

`PUT /media/{id}/authors` takes `{mode: "manual", authors[≤20] {credited_name,
binding: {kind: "existing", contributor_handle} | {kind: "new", id,
display_name}}}` or `{mode: "automatic"}` and answers `{data: {author_mode}}`. manual replaces the author slice in the sent
order and pins it; automatic releases the pin and keeps the rows until the next
observation. a pinned media withholds automatic author proposals and reports
`retained_manual_authors`. the editor mints a new person's id when the row is
added, keeps it across retries and treats a confirmed PUT as the commit point: a
failure after it never re-sends.

## author search choices

`GET /contributors` is a paginated name search, not a ten-result suggestion
contract. `lib/contributors/api.ts` normalizes each typed response for the shared
collection owner. the author editor and search refinement both retain ten-row
requests, publish each page and load to source exhaustion while eligible.
handles identify rows; exact settled-query admission controls existing and new
author choices. later failures retain current choices and require explicit retry.
appending never replaces the active option or moves focus.

the author editor's field is shell-owned: its mounted interactive lifetime and
open suggestions determine activity, without requiring a pane runtime. search
refinement activity requires both its pane and its options disclosure. closing
suggestions or filters pauses further appends; admitted reads may settle. shared
exhaustion feedback owns progress, recovery and completion speech, returning retry
focus to the author input. the existing explicit create/bind/save commands are
unchanged.
