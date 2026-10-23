# pdf reader close exception

successful native offline run `20261022-170240-4acd2ec3b1cf` emitted a stackless
`UnknownErrorException` at00:09:54.975 utc after the rendered-reader capture and
return to downloads. the real document rendered and the return action succeeded.
private evidence: `artifacts/native-controls/android-offline-browser.jsonl`.

`PdfSurface.tsx` aborts its controller and starts `task.destroy()` during cleanup;
this is a candidate boundary, not an established cause. capture the originating
exception/promise and repair its owner. resolution: open and close a real pdf
without an unhandled page exception, preserving document teardown and navigation.
