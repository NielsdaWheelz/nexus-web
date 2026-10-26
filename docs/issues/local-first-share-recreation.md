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
