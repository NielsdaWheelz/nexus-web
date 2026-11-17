# an attached passage reaches the model without its source

status: open · found 2026-11-12 by reading at `125f1ab87` · area: backend / prompt resolution

`resolve_prompt` renders a `passage_anchor` as its normalized words, labelled with
its own first 120 characters (`python/nexus/services/resource_graph/resolve.py:612-616`).
a highlight is labelled `Highlight in “title” by authors` and a selection carries
its item label; a passage names no source at all.

impact: the model is given a quote with no title or author, so it cannot attribute
it or tell two attached passages apart by source.

resolved when a passage's prompt label names its source, as a highlight's does.
