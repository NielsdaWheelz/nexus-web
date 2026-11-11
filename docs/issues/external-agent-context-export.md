# selected context for external agents

status: explicitly deferred by the owner on 2026-11-10 for a future agent.
keep outside the current journal, task and habit work. no implementation authorized.

problem: nexus has internal agent reads but no selected-context export or
external read interface was found in the inspected application surfaces.

evidence at nexus `71726834845554b5d533b07bf83d13d5e26b69da`:
`python/nexus/services/tools/contract.py:508-553` already defines bounded
search, resource reads, document search, inspection and relationship reads.
`python/nexus/services/tools/memory.py` is a client of an external memory
service, not a nexus mcp server. logbook `078b82c` exposes filtered json and
markdown through `backend/app.py:753-797` and `backend/agent.py`.

impact: using a chosen part of the corpus with another agent requires manual
assembly despite existing retrieval and provenance contracts.

decision: establish a real external-agent workflow. begin with an explicit
read-only export of a selected scope if sufficient; an always-on server is not
required. reuse existing identities, locators, admission and bounded reads.
state whether output includes local unsynced writing or only server-accepted
content; never silently omit it while claiming completeness.

future pickup: recheck existing internal tools and any newer external interface.
include typed task state and dated habit facts; do not infer them from rendered
checkboxes or collapsed journal rows. existing internal reads expose admitted
server-accepted work facts ([model tools](../modules/model-tools.md)); reuse that
contract without mistaking it for this separate external handoff.

resolved when a selected scope can be consumed without browser automation,
with readable text, stable source references, declared limits and complete
pagination or explicit truncation. no new retrieval engine or automatic
transmission to an external model is implied.
