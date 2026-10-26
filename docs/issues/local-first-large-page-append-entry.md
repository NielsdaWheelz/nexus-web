# large-page append entry

in the mobile-editor integration (`953f56466677`), a page with another adjacency page renders `show more items` instead of its trailing autosaving input (`LocalOutline.tsx:762`). the indexed-tail `append()` path exists (`LocalOutline.tsx:305`), but its page consumer only handles an internal `AppendNote` pane entry. the visible quick-note action targets today, not an arbitrary page.

this blocks a bounded, user-driven tail append on the declared 100,000-child page. loading the whole prefix or calling a private editor handle would not qualify the required ui/capacity behavior. the candidate exposes “write at end” beside explicit pagination and reuses the existing indexed tail operation. automatic intersection-driven pagination is removed so the entry cannot move under the pointer. revealing the input creates no note; filtering and an existing draft suppress the action. live qualification remains pending.

resolved when both actual firefox and packaged android can reach the large page's tail input through normal ui, append ten notes without mounting the corpus, and prove exact canonical tail order. the revised disposable capacity drivers must measure first trusted input through the committed row's visible paint; they cannot retain the removed explicit save-note flow.

actual red on `9836f73b6`: lab `20261025-185429-a6974b14e059` loaded the 101-note page and proved its prefix/show-more controls; no write-at-end button existed. static gate passes. actual browser green on `dc4467ee3`, lab `20261025-190057-010e0f65ea7e`: the indexed tail opens without changing command sequence, mounts at most 100 rows, then typing creates exactly the 102nd final note. the declared 100,000-block firefox/handset run remains pending.
