# the catalog sends disclosures no client reads

found on 2026-11-12 at `858cb192e`; still present at `6fc320a75`.
`GenerationCatalogRoute` and the chat seed's `SelectionPresentation` carry
`billing`, `privacy` and `processor_chain` in `python/nexus/schemas/llm.py`.
`apps/web/src` has no reader outside the generated wire. the owner chose no
chat disclosures on 2026-11-12; this record does not propose adding them.

these fields enlarge the public rendering contract without a consumer. retain
their distinct server uses: `python/nexus/services/chat/admit.py` uses
`processor_chain` to select a tool plan and freezes the presentation into the
generation specification.

resolve by removing unused public fields at the catalog projection, following
the wire cutover contract, without deleting the server's admission/audit facts.
