# feed subscription admission scales with per-entry permission reads

observed at `ef44ba92d` on 2026-11-17 in lab
`20261117-124529-e2250fc5421d`: named-library feed admission returned 202 after
31,632.53ms, 30,392.8ms and 35,115.36ms, beyond the browser driver's 30-second
deadline. private evidence is the run's `api.log`; the last request was
`POST /libraries/0df7a670-5f19-4351-a0dd-34c881c4b236/feed-subscriptions` at
20:55:07 utc. the real npr fixtures included shows with hundreds to 1,750 entries.

`library_entries.py:405-416` checks `can_read_media` separately for every media
and destination member inside `deliverable_feed_media_ids`. subscription
admission calls it while holding its transaction; the logs also contain
serialization failures through that path. this is a concrete scaling lead,
not a measured allocation of the whole request's cost.

impact: an ordinary large-show subscription can outlast a client deadline and
contend with account writes. sigla uses smaller real feeds to isolate its
presentation checks; that does not qualify large-show admission.

resolve by measuring and reducing the owning transaction's query work while
preserving exact member visibility, admission fences and atomic publication.
prove large-show admission and responsive unrelated writes through product
endpoints without exhausted busy errors or unknown outcomes.
