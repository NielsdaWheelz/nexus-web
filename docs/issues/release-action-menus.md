# combined reader menus' spoken title on native android

problem: the combined reader toolbar's complete spoken title/count has not been
heard on native android. earlier native toolbar proof used the retired popup
owner and cannot establish the final sheet's spoken behavior.

evidence: combined source `2bb025878` uses the `Immediate` section source and
preserves the complete title/count and native trigger bindings. production lab
run `20261020-081706-3445366744ac` passed the focused real-publication browser
check, which establishes browser integration, not speech.

after device authorization, check the complete spoken title/count with talkback
on the combined source. record the served source/artifact, device/webview,
screen reader and observed outcome in the pr. resolved when that passes.

retain the independent [post-drag reopening](android-webview-post-drag-menu-reopen.md),
[handset announcements](action-menus-physical-handset-qualification.md) and
[default startup](android-isolated-root-redirect-blank.md) issues.
