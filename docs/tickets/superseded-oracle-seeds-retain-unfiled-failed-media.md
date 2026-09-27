# superseded oracle seeds retain unfiled failed media

status: open
origin: 2026-09-26 live processing inventory
area: oracle source reconciliation / media lifecycle

old standard ebooks seeds for paradise lost
`391c2a71-233a-4815-8904-d51db5c49782`, frankenstein
`29980cbd-2b9f-479b-84d6-d16a0e20ae8b`, and moby dick
`70d60b0e-a1ca-4360-950b-98288ccb279f` remain failed. their saved urls return
an html download landing page; the explicit `?source=download` targets return
valid epub containers. validation correctly rejected the original html.

production `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d` now maps these works
to different gutenberg media, all readable and indexed. each old row has zero
library entries and zero oracle mappings; none appears in the 24 attention
items. `services/oracle_corpus.py:186` replaces mapping/filing but retains the
old media. evidence: `/tmp/nexus-processing-review-20260926/visible-and-oracle.jsonl`
and `standardebooks-probes/artifact-results.json`.

audit all remaining references and the existing media lifecycle before any
cleanup. retire truly unreferenced failed seeds through that owner if required;
do not reimport obsolete editions or delete rows directly. for future configured
downloads, retain file validation and use the actual artifact url.

acceptance: current oracle mappings and evidence remain intact; stale unfiled
rows are either deliberately retained with a documented reason or removed
through safe lifecycle cleanup.
