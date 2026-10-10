# semantic recall can thin out under medium-selectivity scopes

status: deferred · origin: 2026-10-10 search reauthor (cleanup/search-reauthor, design §11.5) · area: search

`search/semantic.py::nearest_chunks` takes the `max(200, 4k)` nearest chunks the index
yields and filters them by the caller's owner predicate. a broad scope keeps nearly all
of them and a narrow one (one media, a frozen chat context) lets the planner filter
first and sort exactly; a medium scope (a library holding a few percent of the corpus,
or a frozen context the planner misjudges) can be driven by ivfflat and keep only the
few neighbours that fall inside it, so fewer semantic-only hits surface than a
filter-first scan would find. lexical hits are unaffected.

prerequisite: confirm production's pgvector version (iterative index scans need 0.8).
fix: `SET LOCAL ivfflat.iterative_scan = relaxed_order` inside `nearest_chunks`, keeping
the bound-constant order.
acceptance: a library-scoped semantic query on the restored corpus returns the same
neighbours as an exact filtered scan for a sample of queries.
