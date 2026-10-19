# highlight annotation read order disagrees

status: open
origin: 2026-10-16 resource presentation audit; origin/main ff57128842b470510446b3edca54922ebcace41e
area: resource graph, highlight notes

the batched highlight-note read orders by note creation before attachment (`python/nexus/services/resource_graph/highlight_notes.py:35`); the single-highlight read orders by attachment (`:56`). historical highlights can retain multiple attached notes, so readers can disagree about the first annotation. `services/highlights.py:377` consumes the batched order.

use one canonical order: attachment creation, attachment id, note id. preserve every note; show the first inline and the others through direct connections.

resolved when two notes created in one order and attached in the opposite order yield the same first annotation in single, batched and shared-preview reads. this finding is from source inspection; no live reproduction was run.
