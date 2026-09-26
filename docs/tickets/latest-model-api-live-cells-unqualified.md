# latest model api live cells unqualified

status: waived by owner for xai · origin: 2026-09-25 latest-model cutover live matrix · area: generation qualification

## evidence and impact

the final pinned provider matrix attempted all 65 api model/configuration
cells. 61 returned usable nonempty terminals with native reasoning evidence:
34 openai, 20 anthropic, 3 gemini, and 4 deepseek. the nonsecret receipt is
`/tmp/provider_all_cells_live_results.json`. no xai credential exists in the
protected nexus or devbox sources inspected, so all 4 grok 4.7 cells remain
unqualified. on 2026-09-26 the owner said to skip that missing credential;
this waives live proof, not catalog membership or correctness.

## prerequisite and acceptance

if grok live qualification is later required, provide a valid xai credential
and rerun the exact four cells with usable terminals and native configuration
evidence. keep the temporary matrix while the overall cutover remains blocked.
