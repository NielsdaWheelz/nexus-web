# passage attachments lose citation numbering

problem: a fragment attachment materializes as a passage anchor, whose literal
body enters chat context without a citation candidate number.

evidence at `41b6872a1`: `services/resource_graph/context.py` materializes fragment
attachments; `services/resource_items/capabilities.py:144` gives passage anchors
quote rendering but no citable result type. `services/chat/context.py:316`
therefore returns no attached citation. real baseline run
`20261104-222437-8d165b7b1cb6` supplied the body without `n`; normal publication
removed `[1]` and reported `CitationsUnavailable`.

impact: attached passage evidence cannot be cited through the supported numbered
context path. this predates imported source citations.

resolved when: ordinary fragment/passage attachment produces a numbered candidate
and a real generated `[1]` publishes one exact retained citation end to end,
without fabricating retrievals or run state.
