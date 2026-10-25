# reopened store claims current before observing server head

`Sync.facts.head` initializes to `"0"`. after opening a completed local corpus
with no pending changes, `syncStatus` returns `current` before registration or
pull has established the current server head. an offline cold launch can briefly
claim up to date until its first request fails.

represent an unobserved head as null and remain syncing until a real head,
offline failure or explicit admission fact is known. prove cold reopening a
completed corpus cannot publish current before the first remote observation.
