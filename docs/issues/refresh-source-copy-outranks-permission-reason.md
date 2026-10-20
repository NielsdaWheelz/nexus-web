# refresh source shows the attempt copy instead of the permission reason

status: open · origin: 2026-10-19 resource references re-slice harness (H1) · area: resource actions / media verbs

for a viewer who did not create a media, the row menu's "refresh source" reads
"[disabled: source refresh requires a settled source attempt]" instead of the
permission reason. `apps/web/src/lib/actions/project.tsx:712-716` picks
`disabledReason` from `expected_attempt_id === null` before it looks at `blocked`,
so the client fact outranks the server's `PermissionDenied`, against the module's
own rule "the server's reason wins" (`project.tsx:85`). the server sends
`blocked: PermissionDenied` and `expected_attempt_id: null` together for a
non-creator.

impact: the menu explains the wrong cause; the verb stays disabled either way.

fix: when `blocked` is set, leave `disabledReason` undefined so `BLOCKED_COPY`
speaks; use the attempt copy only for an unblocked verb without an attempt.

resolved when: the refs harness journey `act/M2.media-row-not-creator-blocks-with-reasons`
passes (XFAIL with this defect).
