# retained search readiness failure needs attribution

on frozen rollout `3d81ef45e`, invoking the retained search check with
`--fake-providers` fails its combined piece-readiness assertion at
`apps/web/scripts/lab/search.ts:347`: state is not semantically ready while both
media and processing responses advertise text search ready. saved diagnostics do
not include the three values, so the failed conjunct remains unknown. scope and
the earlier partition check pass; a background reindex job completed, without a
retained source/job join proving causality. no timeout occurred.

private evidence: rollout lab `20261025-102613-3d468f263303`, child evidence
stderr/stdout and retained receipt. the documented retained command uses the
ordinary credential-free core lab, without fake providers. running that command
unchanged is the required release check; passing it will not classify this failure.

resolve by capturing the actual values and relevant publication revision in a
small controlled reproduction, then fixing any demonstrated fixture or product
race. do not weaken the assertion or infer that successful workers caused it.
