# add processing sentence exceeds combined word ceiling

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`; web paths under apps/web/src.

problem and impact: add processing sentence exceeds combined word ceiling.

evidence: components/nexus/AddPanel.tsx:232-233 fact `source is still processing` has4 words, reason has12; total16.

counterexample: open saved-library editor for a source still processing.

smallest truthful fix: reason `your libraries are saved; change them after processing.` gives12 total.

resolved when: current source/library save invariants still justify the shortened reason and combined copy fits14.

verification: source only; no lab run. root owns repository records and implementation.
