# a wide notes pane spends its idle half on nothing

recorded 2026-11-17 at ef44ba92d. deferred by the owner from the notes redesign
(the fair copy); drawn in its prototype, artifact 3DdTrswurwCN6HoASwtiFT, lever
`width: wide, with a margin`.

## problem

a notes pane dragged wider than the reader column either stretches its lines or
leaves the right half empty. the row-end facts (a habit's `daily`, a source's kind
and author, a repeat's count) have room for a word or two, so a repeat can only
show a count and a highlight's citation and annotation stack under the excerpt.

## proposal

above a threshold width the text keeps the reader's measure and the rest becomes a
margin. each row's apparatus stands beside it in whole phrases: a highlight's
citation and annotation, `also under …` for a repeat, a carried task's home day.
the tree stays one column, so windowing, drag and arrow motion keep their
one-dimensional geometry. children are never moved into the margin (an earlier
variant did that and demoted them; a reviewer rejected it).

## cost

a second row layout to prove at several widths, and a container query on the
pane. no data change.

## resolved when

the owner rules it in and it ships, or rules it out and this file is deleted.
