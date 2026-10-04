# pdf reader destroys a completed loading task twice

status: deferred · origin: 2026-10-04 source audit · area: pdf reader / web

`apps/web/src/components/PdfReader.tsx:2089–2092,3223–3224,3279–3280` destroys both a completed document and its loading task on replacement, unmount and stale open. in the locked `pdfjs-dist` 5.7.284 `build/pdf.mjs:15087–15088`, `PDFDocumentProxy.destroy()` itself calls `loadingTask.destroy()`; `:14918–14933` owns transport and worker disposal. the second call repeats the same task disposal. no visible failure or measured cost is claimed.

give each open one clear disposal owner. acceptance: completed document replacement, stale completion and unmount destroy its task once; pending opens and partial viewer failures still release their owned task and worker, with no retained resources or changed reader behavior.
