# suggestions hide loading, empty results and later failures

status: open (source-confirmed; affected browser session not captured)
origin: 2026-10-14 lectern latency diagnosis, source `367da80e0`
area: web / suggestions feedback

`apps/web/src/components/collections/SuggestionsSection.tsx:189-200` hides the
section while its first request is loading and whenever retained `rows` is
empty. after a successful empty result, a later refresh error and its retry
button also remain hidden. `CollectionView` always receives `status="ready"`
at line 214. quick reads instead exposes loading, empty and failure states in
`QuickReadsSection.tsx:45-81`.

impact: the user cannot distinguish work in progress, no eligible suggestions,
full lectern, and a failed refresh. backend capacity legitimately returns an
empty result (`python/nexus/services/suggestions.py:67-72`).

prerequisite: agree on visible empty/capacity copy; no code changes are
authorized in this diagnosis. use the existing section/collection feedback
components and retain loaded rows while refreshing.

acceptance: first load, zero results, full lectern, first failure, and failure
after an empty success all have visible, distinct, truthful feedback; failures
expose retry. a nonempty retained list stays usable during refresh.
