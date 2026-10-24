# contributors

nexus keeps one canonical person per author and attaches people to works through
ordered, role-typed credits. source adapters and metadata research publish the
credits; readers follow a name to the person's works. attribution is system
metadata, with no user-facing author write.

## owners

| concept | owner | state |
| --- | --- | --- |
| person | `contributor_writes.create_contributor`, `ensure_alias` | `contributors`, `contributor_aliases`, `contributor_external_ids` |
| credit | `contributor_writes.replace_role_slices` (sole credit DML) | `contributor_credits` |
| observation | `contributor_taxonomy` (`build_observation`, `ObservedRoleSlices`, `NOT_OBSERVED`) | none |
| works view | `contributors._WORKS_PLANS`; the web forwards url keys verbatim | url `sort`/`direction` |
| credit presentation (web) | `lib/contributors/credits.ts` | none |

`contributors.py` is the facade every other module calls: search, detail, works,
refs, batch publication, in-transaction publication, prepare/apply and cleanup.
it owns sessions, retries and when to invalidate.
`contributor_credits.py` holds the sql fragments and loaders consumers compose
(search, library entries, stats, suggestions, resource graph, sharing).

## invariants

- I1 visibility: search lists only people with a visible credit
  (`credited_visible_contributor_ids_cte_sql`); detail, works and ref
  resolution use broad visibility (a visible credit or a viewer-owned graph
  edge). unknown and invisible are one answer: 404 `E_NOT_FOUND` on reads.
  a malformed handle is 404 before any other parameter is parsed. catalogue
  credits are visible to everyone.
- I2 one row per (target, person, role) and per (target, ordinal): unique
  indexes; `replace_role_slices` dedupes and renumbers through a negative range.
- I3 every person has a resolving alias whose literal equals its display name:
  `create_contributor` ensures it at birth; a changed publication re-ensures it.
- I4 handles match `[a-z0-9]+(-[a-z0-9]+)*`, 3..80; they grant nothing and never
  change. a new person takes `slug≤32-<12 hex of sha256(name key)>` while it is
  free, else that base plus 12 random hex.
- I5 observations replace exactly their declared role slices. `NOT_OBSERVED`
  leaves existing credits untouched; an established empty slice clears that role.
  retrying the same roster leaves credit rows unchanged; identity resolution
  may still attach an observed external key.
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
unknown"); catalogue works carry their author credits and no action ref. each
gutenberg work carries its sealed source target; its title opens that target's
preview pane and its shared media icons admit explicit membership. the landing
href remains source provenance and occurrence identity, never an import URL. the
pane drains every page while active (`useServerList`), so its count and filter
cover all works; a failed continuation keeps the rows and offers Retry, a
rejected cursor Refresh list.

## publication

`prepare_observed_role_slices_in_current_transaction` returns the target,
managed roles, complete identity plan and source without writing.
`apply_prepared_role_slices_in_current_transaction` materializes that plan and
returns whether credit rows changed. `apply_observed_role_slices_in_current_transaction`
composes both on the caller's session. the caller commits and owns transaction
retry; batch publication owns fresh serializable transactions and invalidation.

credit `source` records row origin, not authority or verification. retained
user-origin credits can be replaced by ordinary source or research observations.
unchanged rosters keep their rows and original provenance. role replacement
preserves unrelated credits and their relative order; ordinals remain contiguous.

## author search choices

`GET /contributors` is a paginated name search, not a ten-result suggestion
contract. `lib/contributors/api.ts` normalizes each typed response for the shared
collection owner. search refinement uses ten-row requests, publishes each page
and loads to source exhaustion while eligible.
handles identify rows; exact settled-query admission controls author choices.
later failures retain current choices and require explicit retry.
appending never replaces the active option or moves focus.

search refinement activity requires both its pane and its options disclosure.
closing filters pauses further appends; admitted reads may settle. shared
exhaustion feedback owns progress, recovery and completion speech, returning retry
focus to the author input.
