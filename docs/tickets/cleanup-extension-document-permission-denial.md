# denied document permission selects file capture

status: open
origin: 2026-09-21 cleanup audit, main 93563d12b62af0b4f8d84c73269f051cec6555ff
area: auth-extension / browser capture

`apps/extension/popup.js:245-261` returns a document kind or `null`, except
permission denial returns `false` at line 253. its sole caller at lines 300-304
treats every value other than `null` as a document kind. after article
extraction fails, denying source-origin permission therefore selects file
capture, requests permission again, and fails instead of using url capture.

reproduce: capture an extensionless page whose article extraction fails, then
deny the source-origin permission request. the file path is selected because
`false !== null`.

prerequisites: preserve extension capture under the reauthoring plan. include
this correction in that module's rewrite; define document detection as
`"pdf" | "epub" | null` and make permission denial use its non-document result.
keep explicit capture-api failures terminal.

acceptance: manual extension capture with denied inspection permission reaches
the url endpoint without another source permission request; detected pdf/epub
still uses the file endpoint. pass `./scripts/test`.
