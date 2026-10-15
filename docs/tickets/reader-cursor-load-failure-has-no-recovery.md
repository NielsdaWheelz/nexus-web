# initial cursor-load recovery remains unqualified

status: open qualification gap · origin: 2026-10-05 reader rewrite pr2 (carried from `reader-core-pr2-surface-gaps`); reviewed 2026-10-14 at `0bd6619` · area: web reader

the original no-retry explanation is obsolete. ordinary cursor-load failures set
`failed` in `apps/web/src/lib/documentReader/progress.ts:319–323`; revalidation now
retries through `reconcileFence` at lines 218–221 and 270–288. visible window
focus, `online`, `pageshow`, and visibility changes call revalidation in
`apps/web/src/lib/documentReader/DocumentReader.tsx:119–132`.

the complete initial-failure recovery journey remains unproven. retained receipt
`/private/tmp/nexus-x-titles-proof-20261014/reader-progress-green-final.json`, case
`replacement_cursor_failure_is_readonly_and_source_reload_recovers`, proves
read-only behavior after a replacement cursor failure and recovery through an
explicit source reload. it does not prove recovery from a first-open failure
through focus, position restoration or choice, and subsequent reading saves.

next: qualify that journey against the current reader; fix the responsible owner
only if it fails. acceptance: the initial cursor request fails, then succeeds;
focus or activation shows the saved spot or the newer-reading-spot choice, and
subsequent genuine reading saves. no write occurs before the cursor read succeeds.
