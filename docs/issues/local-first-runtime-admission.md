# qualify retained ownership after preparation failure

the runtime source is repaired. `close()` refuses pending, failed or errored
writing before setting retired. `run()` retains its frozen intent and selection
before store opening/read_snapshot; a preparation failure therefore has an owner
to retry even before a change/frame exists. later admitted commands remain behind
its unsettled tail. ordinary provider cleanup calls close, not discard; an
explicitly retired account alone discards its writing.

remaining qualification: a real recoverable read_snapshot timeout followed by the
ordinary retry must preserve that intent, commit it once, then settle a queued
later edit with the next counter. pause the existing worker RPC and retain its
actual 30-second client deadline; no supplied host, private runtime mutation or
fabricated response. a second same-port timeout makes the store terminal and
would not qualify this recoverable premise.

also retain the exact provider-unmount condition: accepted writing must remain
owned and retryable when that provider leaves without account retirement.
ordinary pane navigation unmounts editors, not the account provider; full-document
exit and approved signout are different contracts. do not report those as this
proof. no new production failure is established by this remaining qualification.
