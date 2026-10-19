# a failed library create blocks creation under a new name

status: open · origin: 2026-10-14 library picker design audit · area: web / destination creation

problem: creation feedback belongs to a prior name but suppresses the create action after the user edits the query.

evidence: `apps/web/src/components/libraries/LibraryDestinationPicker.tsx:97,148-168` stores create failure without its input identity; `:194-207` requires no create error before rendering create; `:270,312` forwards edits directly to search without clearing or associating that error. source trace only.

reproduce: trigger a definite create refusal, edit the search to a different valid available name. create remains suppressed by the old failure.

prerequisites: distinguish a definite refusal from unknown delivery; an unknown create must retain its original request identity.

fix: scope definite create feedback to the submitted name and clear it on meaningful edits. retain uncertain creation and its exact retry separately from the current query; editing text cannot manufacture a fresh retry identity.

acceptance: after a definite refusal, a corrected name exposes create; after lost acknowledgement, recovery retains the original request identity without blocking unrelated search editing.
