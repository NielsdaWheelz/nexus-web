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
