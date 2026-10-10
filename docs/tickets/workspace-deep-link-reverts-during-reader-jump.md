# full-page media deep link may revert during workspace bootstrap

status: open
origin: 2026-09-25 article-section-navigation live acceptance
area: workspace deep-link bootstrap

in an isolated Chromium probe, a real EPUB chapter X fragment response was
held after toolbar selection. a full-page `page.goto` to a web article briefly
rendered its six section options, but the URL sometimes reverted to the EPUB
before the held response was released. by contrast, switching with the actual
workspace tab control passed 2/2: article URL/options persisted before and
after releasing the old response, and no EPUB Return leaked into the article.
`usePaneRouter.replace` and workspace `navigatePane` apply the toolbar href
synchronously; the fragment completion has no route writer. this points toward
workspace cold deep-link/bootstrap reconciliation, not a late section-control
completion. the exact bootstrap state remains unattributed.

prerequisite: record route and pane ids plus restored workspace state during
full-page deep-link bootstrap. distinguish deliberate session precedence from
a stale projection that overrides the explicit URL. repair at the bootstrap
owner if the explicit deep link is being lost.

acceptance: a full-page `/media/:id` deep link settles on its requested media
with matching pane URL/options after workspace restore, independent of an old
pane's in-flight fragment response. ordinary tab switching remains stable.

2026-10-09 workspace reauthoring (cleanup/workspace-reauthor): the bootstrap
merge (`enterWorkspace`), the store and the address projection were rewritten;
the address now goes through next's patched `replaceState`, so next's router
url follows the projection (that removed one way an older url could be
re-asserted). remaining hypothesis: the old EPUB pane's late fragment
completion calls its pane router's `replace`, and `navigatePane` activates the
navigated pane by default (`activate` defaults to true), so a background pane's
replace takes activation back from the deep-linked pane. not reproduced here.
