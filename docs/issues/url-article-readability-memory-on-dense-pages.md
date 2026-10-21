# url articles with dense notes exhaust the background worker's memory

status: open
origin: 2026-10-20 reader python ingest harness (`2026-10-20/rpy/harness/defects.txt` N1)
area: url acquisition / node ingest filter (crossing: outside reader python)

every fetched web article passes through the node readability filter
(`node/ingest/article_extraction.mjs`, jsdom) before python prepares it. its
memory grows with dom size: container cgroup peaks of ~195 MiB for a 0.21 MB
page with 2,000 endnotes and ~368 MiB for a 0.54 MB page with 5,000. inside the
448 MiB background worker the 5,000-note page is oom-killed and fails
`E_RESOURCE_LIMIT` (Memory) at stage Validate. the python preparation of the same
html peaks ~135 MiB.

impact: dense pages far below the 10 MiB fetch cap cannot be added by url, and
near the limit the outcome is not even stable: the 1.3 MB wikipedia *Alan Turing*
page failed `E_RESOURCE_LIMIT` (Memory) in one harness cycle and passed the node
step in the next (then python refused it on the apparatus budget), and the
*Hamlet* page imported in two cycles and was OOM-killed in a third, so their
import results depend on the run (the worker's own resident memory varies).
evidence: harness `prep/probe_mem.py`; fakeworld `/articles/many-notes/5000`;
image `c3rp-worker:dev` at main `b3f81e349`; the Turing page in
`2026-10-20/rpy/harness/runs/base-ext.txt.identity` (Turing: Memory),
`runs/tip-1.txt.identity` (Turing: Output) and `runs/tip-2.txt.identity`
(Hamlet: Memory; ready in the other two).

resolved when a 0.54 MB page with 5,000 endnotes imports by url inside the
448 MiB worker, or the owner records a documented page-size bound the add flow
states before fetching.
