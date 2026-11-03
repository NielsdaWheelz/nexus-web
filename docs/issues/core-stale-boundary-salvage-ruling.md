# stale workspace boundary mixes local salvage with update remedy

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`; web paths under apps/web/src.

problem and impact: AuthenticatedWorkspaceErrorBoundary.tsx:93 creates copy drafts for any pendingText; :121 attaches it to the same staleBuild Fact as reload, including as the sole verb under CloseTabs/Reinstall. the stale fact must offer only its actual update remedy, while exportable text must remain recoverable.

evidence: pendingText is guard.readCopyText over all account exporters, with no risk filter. it proves exportable drafts, never by itself proves unsaved text. source :92-93 and :121 join unrelated responsibilities.

root-adjudicated smallest fix: staleBuild Fact gets only usable reload, or no verb for CloseTabs/Reinstall. when pendingText is non-null, a separate Fact `your drafts are available.` owns the existing `copy drafts` verb. preserve existing note-edits/stopped-store rows separately. no new lifecycle, prompt or registry; no salvage is suppressed.

resolved when: final-core author qualifies that each fact owns only its truthful verbs, all update remedies stay actual, and exportable drafts still copy. root explicitly adjudicated this arrangement; no further permission is required.

verification: source only; no lab run. root owns repository record and implementation.
