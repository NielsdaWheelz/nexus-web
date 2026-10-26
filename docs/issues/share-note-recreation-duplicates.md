# share activity recreation duplicates its saved note

current candidate `c929fe940`, installed run
`20261026-094508-6d83ff7b001a`, receives one real offline `ACTION_SEND` and
durably creates one note/day link. actual `Activity.recreate()` then creates a
second note and link for that same intent and day. both are absent on the server,
so this is local lifecycle duplication, not transport replay.

the temporary instrumentation proves saved-instance-state delivery and a distinct
replacement activity. first/recreated canonical queries return one/two distinct
note identities. the next independent send and reconnect checks are not reached.

retain one capture identity/date across recreation of the same intent. a later
independent send of identical text must still create another note. use the
existing capture command's identity/retry contract; add no content deduper or
replay ledger. resolve with unchanged real send/recreate/second-send/offline and
canonical upload assertions, then remove this record.
