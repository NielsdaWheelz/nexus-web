# intermittent offline pdf open failure

real native lab `20261022-165327-b612f1019e1c` downloaded the uploaded pdf to
native `Ready`, disabled both radios, removed host reverses and cold-started a
new app process. the packaged shelf listed the copy and opened its reader, but
the reader reported `couldn’t open this pdf`; no canvas appeared. strict owned
teardown completed. provider: official chromium webview158 on owned api35 avd.

the unchanged source then passed that complete journey in
`20261022-170240-4acd2ec3b1cf`: new process, radios off, actual rendered paper and
return to downloads. added diagnostics did not reproduce `pdf_open_failed`;
runtime imports and viewer construction are known to succeed. the original
exception object was not captured. a cause or repair is not established.

retain the existing `pdf_open_failed` error argument and failed-resource details
on the next occurrence. resolve by identifying and repairing that failure at its
reader/asset owner, then proving the same cold journey. do not loosen csp, add
alternate loading paths or claim the intermittent failure fixed from one pass.

current online installed-shell occurrence: source `e65541648`, Samsung
SM-S906W/android16/WebView155, run `20261025-145003-4e77c998e144`. canonical
reader API answered200; `/media/01a1750c-87af-729d-9377-07fdc1f65a26` displayed
“couldn’t open this pdf” before downloading. screenshot/body are retained under
that run's `artifacts/native-localfirst`; the driver lacked console arguments,
so no cause is established. ten native local-writing/offline/reconnect checks
passed first. next invocation records actual `pdf_open_failed` arguments and
failed resource paths with query strings removed.

that current occurrence has a concrete qualification-build cause: retained
Chromium console for QA pid21109 reports the original.pdf presigned request
blocked by document `connect-src 'self'`. the ignored APK builder reran the
canonical Vite task without the lab's `R2_S3_API_ORIGIN`, although
`vite.android.config.ts` already derives its exact storage allowlist from that
variable. the pending ignored builder now supplies the context's storage origin.
this does not establish the cause of the older offline occurrence; retain that
separate unresolved evidence until the actual cold saved-copy journey passes.

current saved-copy occurrence: source `c20ebe7b6`, Samsung SM-S906W/android16,
run `20261025-154927-241fa518388f`. after repairing the separate shelf render
environment, the real ready copy reaches the pdf reader but paints neither
canvas nor text. a strictly offline installed-qa follow-up observed the same
state for 59 seconds. two local `document.pdf` requests answer200 then abort
after about4 ms, before teardown. direct fetch of that exact local file returns
all597 bytes; PyMuPDF opens them unrepaired as one page with the expected text.
no `pdf_open_failed` or page exception was captured. this occurrence is not
explained by corrupt bytes, missing native storage or a five-second test wait.

next isolate the already-loaded pdf.js module with those actual bytes and then
the exact local url, distinguishing task rejection/retry from surface cleanup.
no transport fallback, csp change or speculative lifetime repair is authorized
by this evidence. the installed cold-copy and annotation journey remains the
resolution condition.
