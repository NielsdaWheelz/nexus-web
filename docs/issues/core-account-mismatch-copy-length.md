# account mismatch sentence exceeds combined word ceiling

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`; web paths under apps/web/src.

problem and impact: account mismatch sentence exceeds combined word ceiling.

evidence: lib/auth/BrowserAccountMismatch.tsx:9 fact has9 words and reason `your workspace stays open in the app.` has7; total16.

counterexample: open hosted account management with a browser using a different account.

smallest truthful fix: fact `this browser uses another account.` gives12 total with the retained reason.

resolved when: combined fact+reason fits14 and the app retention claim remains true.

verification: source only; no lab run. root owns repository records and implementation.
