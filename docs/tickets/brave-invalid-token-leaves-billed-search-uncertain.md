# brave invalid token leaves billed search uncertain

status: open · origin: 2026-09-26 latest-model tool qualification · area: llm-tools web search

## problem and evidence

Brave returned HTTP 422 / `SUBSCRIPTION_TOKEN_INVALID` to task run
`7e4f8d86-096f-4883-9014-984d9dfb87dd`. `llm_tools.web.brave._error_from_response`
classifies every other 4xx as `INVALID_REQUEST`; both it and `INVALID_KEY`
become a host-policy exception in `llm_tools.web.tools`, leaving the billed-once
position `Uncertain`. changing the status mapping alone would not settle it.
the external request occurred, but no search result was returned.

## prerequisite and acceptance

in llm-tools, recognize the bounded upstream invalid-token code and declare
an honest credential/configuration failure with the actual attempt count and
no redispatch. prove that a conclusive rejection settles once, while unknown
provider failures remain uncertain. update the nexus pin only after its live
tool contract is requalified. do not infer settlement for the existing run.
