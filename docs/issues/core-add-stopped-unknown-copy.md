# stopped add uses obsolete unknown wording

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`; web paths under apps/web/src, native paths under apps/android/app/src/main/java/app/nexus/android.

problem and impact: stopped add uses obsolete unknown wording.

evidence: components/nexus/useAddContentSession.ts:370 maps a Submitting row on stop to AcceptanceUnresolved(StatusUnknown), with fact `change not confirmed` and reason `check save to retry the original request.`. AddPanel.tsx:475-477 renders it as a Hold with sending retry.

counterexample: stop a submitting item before its acceptance response; the original immutable intent is retained but visible copy says request and suggests check.

smallest truthful fix: use `not sure that saved.` and UNKNOWN_OUTCOME_REASON at this producer. existing retry remains retry.

resolved when: stop-created unknown uses the canonical unknown line and unchanged frozen intent.

verification: source only; no lab run. root owns repository records and implementation.
