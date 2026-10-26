# immediate native input after return can disappear

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
controls and timing support a native editing-host/InputConnection handoff
cause; native InputConnection logs have not been captured.

cross-root artifact audit rules out overlapping index install, launch or input:
the mobile trace bounds its device calls to `2026-10-26T02:06:09.709Z`–
`02:06:36.392Z`; index's first install began no earlier than
`02:11:22.907Z`. build-only package/mapping reads have no individual start
timestamps, so the audit does not establish absence of all read-only adb traffic.

the prior `LocalOutline.startSplit` mounted a temporary input; `completeDraft`
replaced it with the canonical successor. the integrated flat editor removes
these handoffs, but installed-device qualification remains pending. preserve the immediate physical sequence without keyboard delays or a
second native edit interpreter. resolve when repeated real return/typing and
canonical rich-body checks retain every key, alongside undo and offline reopen.
