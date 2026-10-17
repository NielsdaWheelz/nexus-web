# selection composer qualification

2026-10-15 · [contract](selection-composer-plan.md) · online-only integration

status: current api/browser/static qualification and owned fixture cleanup
completed. publication is held by the release coordinator’s main freeze. real accepted generation and physical
phone/os ime remain unverified; neither is counted as green.

## identity and method

initial implementation `7eba8aadc` was qualified against baseline
`367da80e0c1beb1c426f6d2d72201b0733809b50`, schema0278. the original
[identity](verification/selection-composer-20261015/identity.json),
[receipts](verification/selection-composer-20261015/receipts.json), screenshots
and static output describe THAT snapshot. its reload-journal proofs are historical
and do not establish the final online-only contract.

main retired the note writer/ledger, resource surfaces, actions and editor before
publication. the owner explicitly chose main’s online-only contract. this change
was ported to main’s canonical owners and rebased through `cd0e43042` (navbar,
overflow and inspector composition). source identity and new integration receipts
distinguish this code from the original qualification:
[current source](verification/selection-composer-20261015/identity-integration.json),
[api/outline](verification/selection-composer-20261015/api-outline-integration.json),
[browser](verification/selection-composer-20261015/browser-integration.json),
[static gate](verification/selection-composer-20261015/gate-integration.json).
the browser manifest enumerates original ephemeral artifact hashes; normalized
json observations and two selected settled screenshots are retained here.
[desktop](verification/selection-composer-20261015/reader-integration-desktop.png) ·
[mobile](verification/selection-composer-20261015/reader-integration-mobile.png).

all live writes use disposable accounts and synthetic text/pdf/rich-note fixtures
in task-owned local web3295 → bff → api8595 → postgres59750, minio and ordinary
password authentication. the task database is migrated to0286 and web/api use wire2.
no production operation, successful provider substitute, shared dependency install
or test-only product seam. transport faults hold/lose actual responses without
inventing successful mutations. destructive cases inspect committed rows/edges.

## current observations

| boundary | observed evidence |
|---|---|
| api / data | exact text/pdf extent reuse preserves colour; lost create/save/delete acknowledgements converge; same-id empty save; stale body409; detached edit/delete409 |
| deletion | every note edge, historical citation and view state removed; highlight and old chat text survive; all affected highlight slots advance; late initial create409; old delete preserves replacement |
| paired reads | red: a held real version read paired “atomic old” with version2; green: canonical joined read returns “atomic new” with version2, reused by note and highlight readers |
| deletion retry | red: exact old delete after highlight deletion404; green: already-absent note200 even with missing highlight; an existing replacement survives and still refuses deletion through that missing highlight |
| browser / data | native immediate first character with zero writes in chromium147/firefox148/webkit26.4; text/pdf rich save and prefill; same-id empty save; guarded global delete; highlight-only delete keeps its note |
| reader ownership | mobile390×844 rich draft/caret survives actual reader-body unmount; held committed save a200 cannot change b’s body/focus; mounted evidence editor closes on global deletion |
| queue / late reads | real delete200 held after commit; optimistic undo queued behind it sends zero resurrection requests; held old outline response cannot restore note/links; unrelated settled undo still persists |
| chat navigation | blank shortcut opens quoted chat with no run; pane-cap refusal keeps composer and persistent notice; retry after closing a pane only navigates, with no ensure/note/run resend |
| visual | settled desktop/mobile surface opacity1, opaque background, readable foreground and containment inside source bounds; earlier ghosting was an entry-animation screenshot |
| static | final `./scripts/test` exited0 on the qualified source digest; `git diff --check` passed |

independent reviews cover reader/geometry, rich editor/content, persistence,
chat retention and deletion consumers. integration review fixed cold-map alias
loss, stale conflict-read admission, acknowledged save/delete obscured by failed
refresh, deleted saved-note conflict snapshots, atomically paired body/version
reads, and deletion publication before the shared queue advances. outline read
admission and queued undo use the existing committed-deletion fact; normal outline
remove remains undoable. the evidence editor no longer retains a globally deleted
note, and its unused quick-note creation-wait path is removed.

## remaining qualification

real local catalog/admission returned `503 E_GENERATION_RUNTIME_UNAVAILABLE`.
nonblank accepted conversation creation, first prompt, canonical quote provenance
and terminal delivery remain unverified. the prepared generation host was never
started and never acquired/refreshed the shared local codex login.
[follow-up](tickets/selection-composer-live-generation-unconfigured.md).

`adb devices -l` found no device; `xcrun xctrace` was unavailable. native desktop
ime and android/ios selection handles, keyboard viewport and composition need
actual devices. synthetic composition guards and desktop browser checks cannot
substitute for them. [follow-up](tickets/selection-composer-native-input-unverified.md).

manual continuation: select text/pdf and immediately type; enter saves,
shift-enter inserts a newline, command/control-enter starts quoted chat. reopen a
saved mark and verify full rich prefill. edit → chat → return restores draft/caret
without saving the note. clear+enter retains the empty note and its links; a fresh
empty backspace deletes it globally. test a mounted note pane and numbered citation,
then retry a held mutation and undo an earlier outline edit. no deleted note may
reappear. reload intentionally loses visit drafts and submitted-command recovery.

## costs and cleanup

[explicit costs](selection-composer-plan.md#explicit-costs) include wrapping rows,
authoritative prefill delay, touch-to-focus, tab-local recovery, coarse links-slot
conflicts, valid highlights remaining after downstream refusal, parent extent
fences, permanent global deletion and affected outline undo-history invalidation.
matched web/api deployment is required. temporary tests leave no regression suite.

unrelated findings remain separate: [docker address pools](tickets/local-docker-default-address-pools-exhausted.md),
[docker enumeration](tickets/local-docker-stopped-container-snapshot-missing.md),
[mobile tab titles](tickets/mobile-reader-tab-loses-runtime-title.md), and
[chat-answer geometry](tickets/selection-dock-does-not-follow-scroll.md).
[source-inferred external evidence detachment](tickets/evidence-note-editor-survives-external-detachment.md)
is a separate follow-up; this change settles global deletion.

all browser contexts and temporary drivers are closed/deleted. the owned native
web/api process groups, six containers, three exclusively owned fixture volumes,
one network and private temporary root are removed.
[cleanup receipt](verification/selection-composer-20261015/cleanup-integration.json).
shared credentials, dependency targets and other worktrees are preserved. no prune,
reset or production operation. feature publication stays on its branch during the
release freeze; no merge, protection change or deployment is performed.
