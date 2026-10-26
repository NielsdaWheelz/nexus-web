# qualify retained ownership after preparation failure

the runtime source is repaired. `close()` refuses pending, failed or errored
writing before setting retired. `run()` retains its frozen intent and selection
before store opening/read_snapshot; a preparation failure therefore has an owner
to retry even before a change/frame exists. later admitted commands remain behind
its unsettled tail. ordinary provider cleanup calls close, not discard; an
explicitly retired account alone discards its writing.

live run `20261025-212216-4c293cc5ee65` on `b1b09675f` passes the real
recoverable read_snapshot timeout and ordinary retry. the actual shared worker
paused on this note's preparation request through its unchanged 30-second client
deadline; the error appeared while the command lease remained retained. retry
committed the retained first intent and queued later edit exactly once each
(`command_seq + 2`), preserved offline server absence, then uploaded the exact
final text on reconnect. no replacement store or fabricated response was used.

also retain the exact provider-unmount condition: accepted writing must remain
owned and retryable when that provider leaves without account retirement.
ordinary pane navigation unmounts editors, not the account provider; full-document
exit and approved signout are different contracts. do not report those as this
proof. no new production failure is established by this remaining qualification.
