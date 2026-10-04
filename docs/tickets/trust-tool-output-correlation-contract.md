# trust tool output leaves correlations to the browser decoder

status: deferred; source-verified, runtime not_run · origin: 2026-10-04 chat native-read review
area: chat trust / typed wire

`TrustToolCallOut` in `python/nexus/schemas/conversation.py:557–575` models the fields but does not require `result_count == len(result_refs)`, `selected_count == len(selected_context_refs)`, or unique machine-authorship targets with one effect identity. `message_trust_trails.py:225–248` currently derives counts from the arrays; `apps/web/src/lib/conversations/trustToolCallWire.ts:268–312` still enforces these cross-field rules. dropping that browser decoder now would weaken the declared output contract and the trust/undo display boundary. no invalid producer result was observed.

move the proven correlations to the native output owner before retiring the browser decoder. verify a current nonempty tool projection, each invalid correlation, and unchanged valid wire/domain behavior; retain separate persisted and undo input validation.
