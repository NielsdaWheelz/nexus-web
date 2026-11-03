# invite unusable-link sentence exceeds combined word ceiling

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`; web paths under apps/web/src.

problem and impact: invite unusable-link sentence exceeds combined word ceiling.

evidence: components/auth/EmailActionLanding.tsx:19 fact `it may have expired or been used.` is7 words; reason `ask the nexus owner for a new invitation.` is8; total15.

counterexample: render the unusable invitation landing.

smallest truthful fix: reason `ask the owner for a new invitation.` gives14 total, preserving opaque may statement.

resolved when: combined fact+reason is at most14 designed words.

verification: source only; no lab run. root owns repository records and implementation.
