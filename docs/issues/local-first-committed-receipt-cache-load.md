# committed receipt depends on cache loading

an incoming mobile-editor change awaited pending document loads after sql commit.
a failed load therefore reported a committed command as a local save failure;
a stalled load also delayed its receipt.

the disposable runtime-receipt-cache.mts diagnostic reproduced a durable note
with command sequence 1 followed by localcommiterror from an interrupted
concurrent document read. it uses a supplied host and real disk sqlite; this is
control-flow evidence, not installed browser/native acceptance.

the runtime now installs initialized document baselines immediately and attaches
a nonblocking, fenced success continuation for pending loads. loading failures
remain with the document-opening owner. static qualification and the existing
live durability/mixed-device cases must confirm integration before closure.
