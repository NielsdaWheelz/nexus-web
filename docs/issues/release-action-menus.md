# qualify combined reader menus on native android

problem: combined reader-toolbar and action-menu native qualification is
`NOT_RUN`; no further device actions are authorized. earlier native toolbar
proof used the retired popup owner and cannot establish the final sheet's touch,
focus or spoken title/count behavior.

evidence: combined source `2bb025878` uses the `Immediate` section source and
preserves the complete title/count and native trigger bindings. its static gate
passed. production lab run `20261020-081706-3445366744ac` passed the focused
real-publication browser check: coarse touch entry, keyboard/focus containment,
enlarged text, narrow bounds, resize closure/reopening and canonical section
inspection without saving the cursor. this establishes browser integration;
native acceptance and production activation remain separate.

after device authorization, qualify the combined source on supported android:
touch selection, enlarged text, complete spoken title/count, focus recovery and
resize closure/reopening. record exact served source/artifact, device/webview,
screen reader and observed outcomes in the pr. resolved when those checks pass.

retain the independent [post-drag reopening](android-webview-post-drag-menu-reopen.md),
[physical handset](action-menus-physical-handset-qualification.md) and
[default startup](android-isolated-root-redirect-blank.md) issues; browser success
does not resolve them.
