# android playwright webview attachment can wait indefinitely

`AndroidWebView.page()` caches `_fetchPage()`, which calls `connectToWebView`
with `kNoTimeout` in the installed playwright `coreBundle.js:64771–64778`.
this can hang disposable qualification or leave it unable to distinguish an
attachment stall from a blank application document.

historical run `20261020-020906-fa069e2d264f` required an owned intent to unblock
attachment; its original application state and root cause were not isolated.
the application now cold-starts without that intent: source `c8f6d7383`, real run
`20261023-101748-008c5ea88487`, passed cold restoration and cleanup through
bounded direct cdp attachment. this qualifies application startup, not the
public android connector.

resolve when the supported android sdk attachment reaches an already-loaded
owned document with bounded waiting and without another navigation. diagnose or
repair that library/driver boundary; do not add a product navigation workaround.
