# long duplicate epub section ids can loop forever

status: open
origin: 2026-09-11 reader structure audit
area: epub navigation identity

## evidence

`python/nexus/services/epub_ingest.py:2624-2647` truncates a section id to
255 characters. after a collision it appends `~2`, `~3`, and so on to the
untruncated base, then truncates again. when the base is at least 255
characters, each suffix is removed and the candidate never changes. two toc
targets sharing that prefix, including two labels for one long target, enter
an unbounded loop. the parse-time check at `:841-843` occurs afterward and
cannot stop this loop.

## prerequisites and fix

none. reserve suffix space before truncating, or use a bounded stable identity
encoding that preserves distinct complete source targets and duplicate aliases.
keep presentation labels separate from target identity.

## acceptance

a bounded parser proof imports duplicate and distinct long target paths
sharing their first 255 characters; extraction terminates and emitted ids are
unique, deterministic, and within the storage limit.
