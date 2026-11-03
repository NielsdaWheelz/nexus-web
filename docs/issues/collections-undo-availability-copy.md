# collection review promises undo until reload despite earlier retirement

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`; web paths under apps/web/src.

problem and impact: collection review promises undo until reload despite earlier retirement.

evidence: components/collections/CollectionConsumptionDialog.tsx:68 says `undo stays available until you reload or sign out.`. lib/consumption/collectionCommands.tsx:98-106 deletes inverse entries when any observed item revision exceeds its applied revision.

counterexample: mark collection finished; observe a later item state change before reload; undo can disappear earlier than the stated condition.

smallest truthful fix: `undo is available until items change, you reload, or sign out.` (12 words).

resolved when: prose names the actual observed-newer-revision retirement boundary and account lifetime.

verification: source only; no lab run. root owns repository records and implementation.
