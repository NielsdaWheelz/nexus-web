# epub structure release and norton repair

status: awaiting release and production repair

- pair backend, web, firefox and android on wire 26. review any other installed
  clients that send the wire header. downloaded reader archives keep their schema.
- before replacing the index job's preparation path/payload, drain old active
  media-index/preparation jobs under the canonical deployment procedure; refuse
  cutover while an incompatible job can still execute. terminal history remains
  history. do not add a legacy executor. preserve the current proof hash format
  while advancing only the epub preparation detector revision.
- verify ordinary indexing cannot publish new navigation, editor/discovery do
  not silently prepare, and failed preparation leaves search usable. fresh
  imports record their successful preparation witness.
- verify a recoverable backup and the deployed source identity before repairing
  norton. run `nexus epub-repair preview <media-id> --projection navigation`
  with private output permissions. review the installed and candidate projections.
  extract the `review` object into a private json file for
  `nexus epub-repair apply <review-file>`. apply checks all fences and can be
  replayed. repeat with a fresh apparatus preview after navigation verification.
- repair only media `39cc0b8a-20f0-40e5-a7df-960a27c22f3e`. review all changed
  parents, ends and rich cuts, including installed-to-main drift. confirm an
  existing highlight, saved position, chapters and fresh/existing reading copies.
- apparatus delivery additionally qualifies public manifest identity, referenced
  item survival, marker withdrawal and exact source/retained body correspondence.
  keep the [unproved note bodies](epub-norton-paragraph-footnotes-unclassified.md) recorded.

no automatic corpus mutation. record implementation and deployment results in
their prs; delete this issue once the paired release and both authorized repairs
have their required proof.
