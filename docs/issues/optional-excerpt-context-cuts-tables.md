# optional excerpt context cuts tables

problem: a source capture can clip an optional context table to the 600-character boundary. a server source `<div><table>…1000 characters…</table>target</div>` with only `target` selected reproduces this: `captureExcerpt` clips before expanding selected tables, leaving a partial unselected table (`node/authored/src/excerpt.ts`, `captureExcerpt`).

impact: the saved tree invents an incomplete table; expanding optional tables instead would exceed the context budget and could refuse a valid small selection.

resolved when this real capture omits the cut optional table, retains the selected word, and whole optional tables that fit remain intact. selected tables must still retain their complete structure, including empty cells. implementation now stops optional context at a cut table boundary; selected tables still expand whole. live proof is pending.
