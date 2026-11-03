# mechanically migrated add retains uppercase and excessive copy

source: frozen `3643a20b466b135e17b5e5c196a00b030df872e2`; web paths under apps/web/src, native paths under apps/android/app/src/main/java/app/nexus/android.

problem and impact: mechanically migrated add retains uppercase and excessive copy.

evidence: lib/nexus/addInput.ts:66 `Use an http:// or https:// link.` and :75 `Only PDF and EPUB files are supported.`; useAddContentSession.ts:379 `Wait for this operation to finish, or stop it before adding items.`; :398-401 starts `Add up to ...` and appends uppercase rejection; :539 `Select the whole link to paste a list.`. these feed Field/Fact through AddPanel.tsx:473,687.

counterexample: bad link/type, busy intake, over-capacity intake or partial-link paste each reaches the named source producer.

smallest truthful fix: lowercase these local sentences; capacity: `add up to {MAX_ADD_ITEMS} items.` / `{places} places left; these items weren’t added.`; busy: `wait for this to finish, or stop it before adding items.`. use lowercase pdf/epub; the exception covers the user’s own titles and names.

resolved when: all local Add Line producers meet the content floor; mechanical-only migration is not mistaken for an exemption.

verification: source only; no lab run. root owns repository records and implementation.
