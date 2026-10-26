# immediate native input after return can disappear

overlap audit: index run `20261025-190630-c84270b9790c`'s existing
`artifacts/native-index/device-call-window-audit.json` bounds its first install
after `2026-10-26T02:11:22.907Z` and first launch after `02:11:23.912Z`.
our failing trio ran at `02:06:25.370Z`–`02:06:25.546Z`; our trace ended at
`02:06:36.392Z`, at least 4m46.515s before that install. index install, launch
and input therefore did not overlap the failing keys. the index builder's
read-only package/mapping queries completed before `02:07:15.758Z`, but their
individual start bounds were not recorded; concurrent reads cannot be excluded.
the separate 37-browser-journey proof is unaffected.

on samsung `RFCT51J2MCH`, real gboard return followed immediately by x and
space intermittently loses x. candidate `3635d7398`, run
`20261025-190444-3e9298c74299`, retained every character in three same-host
code controls, then persisted only a space in the prose successor's canonical
rich body. the window-wide passive observer captured no x event, including
outside editors. this is input loss before DOM delivery, not projection trimming
or an established persistence failure.

calibrated host-relative timing: return injection 0–62 ms; x 62–116 ms; space
116–176 ms. the original row lost focus at 72 ms and the temporary editor gained
focus at 73 ms, during x injection. space reached the temporary editor at
175 ms; focus transferred to the canonical successor at 723 ms. each code
control retained x and space on one editor without a focus transfer. these
controls and timing suggest a native editing-host/InputConnection handoff
cause; native InputConnection logs have not been captured.

`LocalOutline.startSplit` mounts a temporary input; `completeDraft` replaces it
with the canonical successor. confirm and repair the cause at the responsible
editor layer. preserve the immediate physical sequence without keyboard delays or a
second native edit interpreter. resolve when repeated real return/typing and
canonical rich-body checks retain every key, alongside undo and offline reopen.
