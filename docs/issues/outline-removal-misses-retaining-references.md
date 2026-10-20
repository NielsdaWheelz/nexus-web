# outline removal misses retaining references

problem: structural outline removal can delete a note still embedded by another
note or referenced through one of its passage anchors. the last-place check inspects
only selected origins at the exact note endpoint.

impact: removing an outline occurrence can destroy a still-referenced note and
its passage relationships. this also affects structural joins that rely on the
same place count. generic unlink now preserves resources; structural deletion’s retention check
remains separate.

evidence retained after insertion #683 and preserving unlink:

- `python/nexus/services/outline.py:479-500` deletes the opposite note when
  `_has_places` is false; `:614-641` omits incoming `note_body` edges and owned
  passage endpoints.
- `python/nexus/services/note_bodies.py:253-264` creates incoming `note_body`
  embed facts; `:230-245` tears down the note and its passage anchors.
- `python/nexus/services/passage_anchors.py:217-256` deletes relationships touching
  those anchors. `resource_graph/owners.py:10-32` already resolves passage
  endpoints to their owning note.

reproduction to verify: place note b on a page, embed b in note a, invoke guarded structural `remove` on
b's last ordinary outline occurrence. repeat with a link to a passage of b.
source-traced; runtime reproduction not run.

fix: distinguish display places from references that must prevent structural
resource deletion. check incoming embeds and relationships through owned
passages in the same serializable mutation; preserve explicit global deletion.

resolved when structural removal and join cannot delete a note retained by
either reference, including concurrent attachment and stale-version cases;
explicit global deletion still performs canonical teardown.
