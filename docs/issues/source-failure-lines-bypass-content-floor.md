# source-failure lines bypass the content floor

problem: mediaSourceLine renders every FAILURE_COPY title and explanation as a
feedback Line. the earlier copy census incorrectly treated most titles as dead,
so live lines retain capitalization, banned request wording and more than fourteen
designed words. some shared guidance also asserts facts unavailable to this caller.

evidence at candidate90b6bc5: `apps/web/src/lib/media/mediaErrorMessage.ts:43-44`
projects all SafeFailureCode entries; `components/media/MediaInfoOverlay.tsx`
75,100,307 renders the composed sentence. `lib/imports/copy.ts` E_FILE_TOO_LARGE,
E_INVALID_REQUEST and E_SOURCE_POSITION_UNMAPPABLE are direct examples. the last
entry globally claims saved copy kept, though copy.ts496-506 separately knows
can_read and is the responsible place to establish that available copy.

fix one responsible catalog, with concise lowercase title and factual nullable
explanation whose composed Line has at most fourteen words. preserve ordinary
row/history reason labels unless their cause is false; no duplicate error map.
keep recovery guidance behind its actual authority/availability predicate.

resolved when the complete live source-failure projection, including suspended
state and all safe failure alternatives, has current consumer/producer proof and
passes the content floor. independent designer proposals precede writer edits;
final copy refresh must correct the earlier title-liveness claim.
