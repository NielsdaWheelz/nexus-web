# pane chrome release steps

the pane chrome re-slice (branch `cleanup/pane-chrome-reslice`) adds no
migration, env, wire revision, apk or extension change. web and api ship in the
same release, in either order: the old web writes no href the new python rule
refuses (only a crafted call could), and the new web against the old api is
main's behaviour.

1. the preflight did not run before the 2026-10-22 release (`99320b630`). it ran
   after, read-only against production in the api container, count-only:
   all 6 stored workspace states validate with the release's `WorkspaceState`
   (which carries the `PaneVisit.href` rule), and 0 of 104 launcher targets
   (`nexus_usages.target_href`) fail it. the web normalizer over stored hrefs
   did not run; the restored-href cleaners stay deleted on the 0292-era census.
2. prune on first save: 0 rows (one user, 6 rows, 10 kept).
3. owner smoke after deploy. desktop: collapse the rail, hover and Tab its
   items (captions to the right, at once, one at a time; Escape closes); a
   note linking to `/daily` opens today; deleting an open resource leaves no
   recently closed row for its pane. phone: a reader's tap hides and shows the top bar, and
   "show reader controls" works by keyboard; More and Inspector open from the
   bar; the palette says "all 1 tab" at one pane; `/media/not-a-uuid` opened
   from a pane with history offers "go back". expected, by Q13: a failed phone
   pane shows no bar, so the 60 px the layout reserves for it
   (`app/(authenticated)/layout.module.css:31`) is a blank band, and a pane
   that fails on its first visit offers only "details" and the Nexus button.

resolved when these steps have run with the release; then delete this record.
