# resource reader loads full bodies before enforcing its limit

status: open
origin: 2026-09-14, pr #246 memory review after ci `34832804526`, receipt `a04cffa1ae6ff798`
area: agent tools, media reads

`python/nexus/services/agent_tools/read_resource.py:149-166` applies its
50,000-character limit after loading the body. the shared loader selects the
complete pdf `plain_text` at `services/media_read_map.py:211`, or fetches and
joins every fragment at lines 407-419. even a narrow pdf page read loads the
complete document before slicing at lines 252-278. memory therefore scales
with the source rather than the requested result, including reads ultimately
returned as `too_large`.

this pre-existing gap is distinct from the metadata sampler that caused the
recorded worker oom; no oom has been attributed to this reader path.

prerequisites: none. enforce the existing read bound before body transfer and
assembly; read pdf page spans through bounded database slices. preserve
authorization, exact text, character counts, and the `too_large` response.

acceptance: existing read behavior remains exact for permitted small bodies
and page ranges; oversized documents are refused without materializing their
complete bodies in the worker. exercise pdf and fragment-backed documents.
