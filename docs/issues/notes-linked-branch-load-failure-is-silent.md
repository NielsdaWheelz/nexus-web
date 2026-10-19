# notes linked branch load failure is silent

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource presentation audit
area: notes / outline navigation

opening an unloaded note branch or zooming into it discards load failures. the
user receives neither an error nor a retry control. a failed expansion returns
to a closed-looking branch; a failed zoom can leave an empty-looking outline.

evidence: `apps/web/src/lib/notes/useOutline.ts:66-82` removes the loading entry
in `finally` without retaining failure. `:438-446` swallows rejection for both
toggle and zoom. `apps/web/src/lib/notes/outline.ts:95-100` only opens loaded
branches. `apps/web/src/components/notes/OutlineEditor.tsx:551-555` presents
loading but no branch error. this is a source audit; no browser reproduction
was run. on main, the corresponding loader and swallowed failures are
`useOutline.ts:106-123` and `:519-526`.

reproduction: open a loaded page with an unloaded linked note, fail that note's
`/api/notes/outline/{ref}` request, then expand or zoom into it.

prerequisite: branch loading state must distinguish unloaded, loading, loaded
empty and failed. keep the last usable view and show a local retry on expected
read failures; preserve the existing authentication and defect boundaries.

acceptance: failed branch reads remain visibly failed with a working retry;
zoom does not masquerade as a successfully empty outline; unrelated loaded
branches and unsaved note text remain intact.
