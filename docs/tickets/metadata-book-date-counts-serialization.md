# saved lewis first-publication dates await production repair

status: open; local contract qualified, production repair NOT_RUN
origin: 2026-10-01 owner clarification
area: saved bibliographic metadata

tracking: [github #485](https://github.com/NielsdaWheelz/nexus-web/issues/485)

evidence: current installed `bcb86e020` has three independently reviewed actual
metadata jobs: *mere christianity* 1952, *of other worlds* 1966 and standalone
*weight of glory* 1941-11. receipt `803fb8061934` qualifies original stock
`gpt-6-luna/xhigh`, strict schema, useful four-tool research, supported precision,
edition separation and contributor identities/roles. the earlier `bcdaf51de`
cohort is historical. see `docs/metadata-enrichment-verification.md` at `407fcc735`.
these isolated jobs do not correct saved production items.

problem: saved lewis items may retain dates produced under the old meaning or
failed enrichment. the implemented contract uses first book publication for
books/collections and the essay's own first publication for standalone essays.

prerequisites: resolve [production catalog failure](metadata-production-catalog-refresh-fails.md),
complete [reviewed uncertainty disposition](model-history-cutover-blocked-by-uncertain-work.md)
and the separately authorized [aligned release](production-release-pending-since-7dc68929b.md),
including its fresh verified backup. preserve original uncertainty evidence.

fix: identify each saved item's bibliographic unit and admit NEW ordinary
metadata jobs as its creator. inspect their outcomes and persisted facts.
never redispatch old uncertain work or rewrite dates unconditionally.

acceptance: saved books/collections use first book publication; standalone essays
use their own first publication with supported precision. earlier broadcasts or
serialization do not replace a book's first book date; an essay's first periodical
publication does count. reprints do not replace these facts. edition facts, credits
and person identity remain correct. verify completed operations and updated dates
in the live detail and already-open library/author views. failures remain visible
without advancing `metadata_enriched_at`. retain production item/job ids and the repair report.
