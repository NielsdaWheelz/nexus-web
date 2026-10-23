# brave payment response becomes an internal defect

live browse returned http 402 from brave during compact-actions qualification on
2026-10-22. `llm_tools` classified it as `invalid_request`;
`python/nexus/services/browse/brave.py:56` raised
`RuntimeError: Brave Browse provider defect: invalid_request`. the web received
`GET /api/browse` 500 `E_INTERNAL`, request
`99ceea01-c4a5-465e-a711-3ff42b47c179`.

provider payment refusal is an operational failure, not schema corruption. it
currently breaks the browse pane instead of showing actionable provider feedback.
repair classification at the provider error owner and map that structured outcome
through browse's existing failure contract. do not inspect exception text or mask
unrelated invalid requests.

resolve when a real or provider-boundary 402 yields truthful bounded feedback,
while malformed provider requests still surface as defects. the compact-actions
change does not alter provider error contracts.
