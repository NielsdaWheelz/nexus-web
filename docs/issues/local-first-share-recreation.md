# share activity recreation can repeat plain-text capture

`ShareActivity.onCreate` rebuilds `/share?text=` from the original action-send
intent and ignores `savedInstanceState`. its manifest entry has no configuration
recreation exemption. each new share document's `ShareCaptureContent` mints a
new note uuid and freezes today's date only in a react ref. the daily page's
deterministic identity cannot deduplicate the distinct notes.

there is no source-level owner preserving one capture identity across activity
recreation. a configuration change after local success can therefore append the
same payload twice; this is distinct from a deliberate second share. this is a
source finding, not an installed-device reproduction.

qualify with one actual plain-text share, await its local commit, recreate the
same activity by a real configuration change, then inspect the daily outline and
canonical note/link identities. require one note through recreation and cold
main-app reopen; a separate action-send must still create a distinct note.

the proposed owner is activity saved state: retain the account-bound capture
uuid and frozen local date before loading the document, pass that attempt to
the existing capture path, and reuse canonical create/link idempotence. no replay
ledger or persistent unfinished-writing inventory is needed. implementation
awaits a meaningful red and exact first-send/date initialization contract.

success does not close the activity: `ShareCapture` retains its result only in
react and offers open/done links. preserving a uuid alone is therefore
insufficient. if another surface unlinks the captured note before recreation,
replaying `captureToday` can re-add its relationship or restore the daily page.
the original note row, including its tombstone, proves prior completion because
page/note/link commit atomically. deciding whether to submit again must share the
command's atomic preparation boundary; a component precheck leaves a race.
qualify completed capture followed by explicit unlink/delete and recreation as
well as the ordinary duplicate case. replay must preserve the later user action.

`DeviceSession.startup()` reads the local envelope, including the confirmed
account calendar zone, without network access. native identity/date can be
frozen before `loadUrl`; restored account identity must match current admission.
a disposable instrumentation apk using public `Activity.recreate()` is a possible
proof path without changing device rotation settings or product code. its exact
package/signing/lifecycle driver is not yet built or qualified.
