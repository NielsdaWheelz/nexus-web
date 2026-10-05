# passage proposals are labelled "<title> - <title>"

status: open · origin: 2026-10-04 synapse harness (baseline N2, seen again on the reauthor run) · area: resource graph / connections

`python/nexus/services/resource_graph/resolve.py` labels an `evidence_span` as
`f"{media title} - {citation_label}"`. for single-section web articles the
span's citation label is the article title, so Connections and reader
Evidence rows read "Heathland Moths - Heathland Moths" and never say which
passage a synapse proposal points at (harness run 2026-10-04: every passage
proposal row on note1).

fix: label a span by its work plus something that distinguishes the passage
(a section or locator label that differs from the title, else a short excerpt),
in the resolver, so every consumer gets it.

acceptance: two proposals into different passages of one single-section
article carry different, passage-identifying labels.
