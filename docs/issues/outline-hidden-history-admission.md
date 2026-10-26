# releasable hidden baselines cause a hard admission refusal

`f8c2b2ed3` `OutlineController.admitNew()` computes a hypothetical no-history
charge via `bytes(refs(windows, emptyHistory), 0)`, but `bytes()` still includes
unfiltered `binding.encodedBytes()`. it therefore counts hidden baselines owned
solely by history and can refuse before `releaseOldest()` gets a chance to free
them. this is a source finding, not a live reproduction.

retain several large aliases by editing them, close their branches, then grow
the one visible alias past the byte bound. accepted growth must survive. new
admission should retire enough old history to recover room; the current precheck
instead asks to close a branch even when all removable baselines are hidden.

estimate history-free ownership through the existing maps, then use the same
retirement/settlement owner and publish after actual cleanup. prove deliberate
new admission succeeds after minimal retirement while writing and independent
aliases remain intact. retain the ordinary no-history byte-bound control too.

`671837d36` supplies the visible baseline set to the hypothetical estimate,
leaving frozen captures charged and full actual admission unchanged. the combined
root static gate passes. the pressure/retirement sequence is not live-qualified.

the attempted public control is not a red: `20261026-042954-1993d49049f2`
preserves exact 1.89m rich writing, then legitimately creates a successor on the
first enter. ordinary `accept()` refresh had permission to retire history before
that gesture; its assumed fourteen hidden baseline copies were not established.
the invalid disposable case is retired. retain source-only attribution and the
existing successful alias-byte/manual-retirement controls; a specific hidden
pressure proof needs a sound ownership premise, not a larger timeout or private
counter mutation.
