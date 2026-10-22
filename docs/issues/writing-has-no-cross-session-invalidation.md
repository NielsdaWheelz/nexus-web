# writing has no cross-session invalidation

status: open · origin: owner source audit, 2026-10-21 · area: web change publication and shared reads (`lib/api/changes.ts`, `lib/api/serverState.tsx`)

problem: notes, page titles and outlines have in-tab change signals only. an open clean
view keeps old content after another tab or device commits, until something in this
tab moves its stale token or the person refreshes. this is an architectural boundary,
not a regression; it leaves fast cross-device receive unimplemented.

evidence (source at `2e154f053`; not reproduced):
- `apps/web/src/lib/api/changes.ts:5-8`: the signals are process-local; nothing crosses
  tabs.
- `lib/resourceGraph/useResourceOutline.ts:73,82-84` keys outline rereads on those local
  stamps; `lib/api/serverState.tsx:256-278` rereads on key, stale-token or manual
  change only, not on a remote commit, focus or resume.
- `lib/notes/texts.ts:579-584`: becoming visible or online only flushes and nudges
  queued writes; it rereads nothing.
- `python/nexus/api/routes/stream.py` has no writing-change subscription (its streams
  are suggestions, chat runs, oracle readings, artifact builds, media, metadata and
  podcast subscriptions).
- dirty-text preservation and expected-version checks still prevent an ordinary stale
  overwrite (`lib/notes/texts.ts:143-145`; a stale save 409s).

candidate reproduction (not run): open the same clean page in two browsers, save a title
or body change in one, and leave the other mounted with no local writes or navigation;
see whether it updates before a manual refresh.

fix: establish a bounded freshness contract at the shared read owner: refresh on
resume and reconnect, and if continuous receive is required, one account-scoped
invalidation subscription with a resnapshot after connection gaps. account changes must
fence old publications.

resolved when a remote acknowledged edit appears in a clean open view within the agreed
bound, while local dirty prose, selection and undo stay intact.
