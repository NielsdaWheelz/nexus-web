# a source stub's label can be its raw ref

problem: `createHighlight` in `apps/web/src/lib/documentReader/annotations.ts` captures a new
source stub with `label: frozen.source?.label ?? sourceRef` when the host knows no label and no
stub exists yet. the stub's title is then a raw ref such as `media:<uuid>`, and
`localResourceLabel` prints a stub's title, so every surface that names that stub (reference rows,
menus, parents) prints the ref. connections-scroll goal 2 says a raw ref never prints.

impact: rare. hosts pass `source` only for the reader's own media or an x capture fragment, so the
fallback runs for a highlight whose source is another media, a part's owner, with no stub on the
device. the label is durable data, so the ref survives later reads until a known label refreshes
the stub.

evidence: code reading only, at `61562d112`; the connections-scroll corpus never exercises it, and
a1 saw no such row. `localResourceLabel`'s own fallback became `"source"`, but a stored title wins
over it.

resolved when a new stub is never captured with its ref as its label (a typed "unlabelled" capture,
or the type label), and a highlight made from a part with no stub shows no raw ref in the reader's
connections or its parent's menus.
