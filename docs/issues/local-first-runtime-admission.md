# provider-unmount qualification limit

recoverable preparation failure retains its frozen intent, queued writing and
command ownership through ordinary retry. the runtime refuses to close pending
or failed writing; provider cleanup closes rather than discards it. account
retirement alone authorizes discard.

the remaining adversarial probe is provider-only unmount with accepted writing,
without account retirement. no supported user action currently isolates it:
pane navigation unmounts editors, document exit has its own loss guard, and
native account loss retires the account. no current loss defect is established.

qualify that boundary if a deterministic supported trigger becomes available;
retained writing must remain owned and retryable. do not substitute pane
navigation or injected react state. ordinary preparation-failure/retry behavior
is already qualified and needs no additional owner or recovery mechanism.
