# invalid chat output promises unavailable recovery

problem: the invalid-response notice tells the reader to try again, but that
outcome has no rerun action under the current recovery policy.

evidence: `apps/web/src/components/chat/AssistantMessage.tsx:34` says
"The assistant returned an invalid response. Please try again."
`python/nexus/services/chat/reads.py:61,65-82` classifies invalid output separately
and excludes it from rerunnable outcomes. `AssistantMessage.tsx:139-143` therefore
renders no recovery action; `python/nexus/services/chat/admit.py:167-169` rejects
an attempted rerun with `E_RETRY_NOT_ALLOWED`.

impact: the failure notice directs the reader toward an unavailable operation.

proposed fix: make the notice describe the supported next step under the existing
policy. reconsider invalid-output rerun eligibility only as an explicit domain
decision; do not broaden it merely to match stale copy or a presentation change.

resolved when an invalid-output response's instruction matches its available
actions and the same recovery policy still governs the card, menu and admission.
source review only; no runtime reproduction was performed.
