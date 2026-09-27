# publication lock upgrade can block concurrent index settlement

status: open
origin: 2026-09-26 processing-plan adversarial source review
area: publication / queue concurrency

`python/nexus/services/reader_publication.py:163-165` takes media `FOR UPDATE` while
`python/nexus/services/content_indexing.py:1139-1146` deliberately uses `FOR NO KEY UPDATE`
so queue-history inserts can take their foreign-key `KEY SHARE`. composing stored
publication normalization and reindex admission in one transaction can upgrade
the media lock while waiting for a queue row whose worker is inserting history.
this is a static lock-order hazard, not a reproduced production incident.

retain compatible non-key media locks and consistent owner lock order for
non-key publication changes. do not split the publication/index commit.

acceptance: a temporary concurrent real-postgres worker/publication check proves
both transactions finish, old revisions cannot publish, and normalized html,
publication generation and new index obligation commit atomically.
