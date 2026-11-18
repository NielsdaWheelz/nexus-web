# a repeat sign counts only loaded parents

`OutlineController.mirrors` counts distinct parent links in the mounted
session's loaded windows and pending fields. `OutlineEditorRow` prints the
repeat sign with that floor, e.g. `2+`, and names it “at least 2 parents”.
when a second parent has never been loaded here, the row has no repeat sign.

the displayed count is accurate as a lower bound. visibility of a repeat that
exists only on another page still requires a complete incidence query. defer
that query until a workflow needs it. close when a repeat whose other parent
has never been opened is identifiable from its row.
