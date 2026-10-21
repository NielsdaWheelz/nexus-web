# pane chrome release steps

the pane chrome re-slice (branch `cleanup/pane-chrome-reslice`) adds no
migration, env, wire revision, apk or extension change. web and api ship in the
same release, in either order: the old web writes no href the new python rule
refuses (only a crafted call could), and the new web against the old api is
main's behaviour.

1. preflight on the mac, against the newest production backup restored into a
   disposable postgres (deleted after), count-only: the workspace census (row
   sizes, pane shapes, route kinds, query and hash forms), the visits the href
   rule refuses (`PaneVisit.href`: printable ascii, never `//`, no `\` or dot
   segment in the path), every stored state validated with the release's
   `WorkspaceState`, and the web normalizer over every stored href.
   count the launcher history targets (`nexus_usages.target_href`) whose path
   fails the same rule.
   gates: zero refused visits and zero failing states, else the python rule
   must not ship (a refused stored row 500s its device's entry); zero such
   launcher targets (the launcher would offer a row it cannot open); zero hrefs
   holding `nexus`/`intent`/`action` params, zero `/conversations/new` or
   `/pages/new` hrefs with a query, and zero hrefs the normalizer changes,
   else restore needs its href cleaners back (`enterWorkspace` uses stored
   states as stored). the branch's census on the 0292-era backup (c3rh) met
   every gate.
2. record how many rows the first save per user will prune (rows past each
   user's newest 10 by `updated_at DESC, id DESC`); they go on their users'
   next save. independent of `release-unsaved-work.md` step 3.
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
