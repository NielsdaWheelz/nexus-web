# x thread selection drops available ancestors when the conversation root is absent

status: open
origin: 2026-10-14 archive-range peer review
area: x source selection

`python/nexus/services/x_client.py:415–425` seeds the requested post and an
available conversation root, then walks descendants only. with conversation
root `1` absent, captured same-author post `2` replying to `1`, and requested
post `3` replying to `2`, `_thread_posts` returns only `3` despite candidates
`{2, 3}` and a budget of 100. the available ancestor becomes context instead
of a primary thread post. the archive time-range correction leaves this
pre-existing selection behavior unchanged.

fix the thread selection owner to retain the available preceding same-author
chain without inventing missing posts or adding recursive provider requests.
preserve conversation/author identity, chronological ordering, requested-post
inclusion and the existing post bound. acceptance: that exact missing-root
case retains posts `2, 3` as primary; unrelated branches remain excluded and
bounded captures still report `post_limit`.
