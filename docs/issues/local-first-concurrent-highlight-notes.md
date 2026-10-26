# qualify independent offline annotations on both clients

the old server exact-extent alias and duplicate-resize refusal are removed.
the shared authored graph gives each highlight an independent stable id and
retains each attached note/link. overlapping extents do not merge identities;
resizing replaces one complete selection register and preserves that identity.

current-main browser run `20261026-044324-d15a61f681c7` passes two overlapping
text highlights, multiple independent attached notes, exact chooser selection
and deletion of one highlight while the other's notes remain. its concurrent
resize case stops before the second drag because the fixture measures a scrolled
range that the reader subsequently repositions; this is not a merge verdict.

retain until two offline devices create same-extent text and pdf annotations in
both delivery orders, preserving all notes/links, and both installed clients
pass stable-id resize/overlap deletion. include the old-publication race tracked
in [source generations](local-first-highlight-source-generations.md). no manual
recovery destination or coalescing by extent is accepted.
