# required document-search dependency is admitted without a credential

status: open
origin: 2026-10-03 metadata installed live acceptance, source `5d50fda0522c1af9d768a49fcec2606ea52be702`
area: nexus model-tool availability

problem: the required `nexus.document.search` binding reports available when its
embedding credential is absent. metadata dispatch then reaches `CredentialMissing`
inside the callback and remains uncertain. known local configuration absence
should be rejected before model submission, using existing tool availability.

evidence: `services/tool_runtime/bindings.py:51` marks every nexus tool available;
`services/search/service.py:87` prepares an embedding, and
`services/llm_credentials.py:60` rejects absent `OPENAI_API_KEY`. the installed
first book job `086c70f7-24f4-43c0-b0b4-85454ba3f5a7`, generation
`4b42cef1-a713-5776-8d5f-cbc89275f627`, failed there before any web call.
its original uncertainty/effects/native trace are retained; no redispatch.

fix: the nexus binding owner must reflect its configured prerequisite through
the existing `Unavailable` contract. reuse generation admission/readiness;
do not add a metadata-only preflight, search fallback or readiness framework.
configure the existing retrieval credential for genuine research separately.

acceptance: missing credential yields visible pre-submission unavailability with
no generation/turn or successful stamp; configured document search works; sealed
local recovery remains independent of current tool availability. retain original
uncertain work. this does not establish that a configured remote key is valid.
